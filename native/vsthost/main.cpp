// wavepod-vsthost — hosts VST3 audio effects in a process of their own, so a misbehaving
// plug-in cannot take WavePod (or a running recording) down with it. Plug-in editors are
// never opened; WavePod builds its own sliders from the parameter list.
//
// Usage:
//   wavepod-vsthost --scan-module <path.vst3>   prints a JSON array of the module's audio effects
//   wavepod-vsthost --serve                     binary request/reply loop on stdin/stdout
//
// Protocol (--serve), all integers little endian:
//   request: u32 length, then `length` bytes: u8 op, op-specific payload
//   reply:   u32 length, then `length` bytes: u8 status (0 ok, 1 error), data
//            (an error's data is a UTF-8 message)
//   strings in payloads: u32 byte length + UTF-8 bytes
//
//   1 CREATE   u32 inst, f64 sampleRate, u32 maxBlock, str path, str classId(hex)
//              -> JSON {"latency":n,"params":[{id,title,units,steps,default,value}]}
//   2 DESTROY  u32 inst
//   3 PARAMS   u32 inst, u32 count, count × (u32 id, f64 normalized)
//   4 PROCESS  u32 inst, u32 frames, f32 L[frames], f32 R[frames]  -> f32 L[frames], f32 R[frames]
//   5 RESET    u32 inst  (clears delay lines, envelopes etc.)
//   6 GETSTATE u32 inst  -> component state bytes
//   7 SETSTATE u32 inst, bytes  -> JSON [{"id":n,"value":v}] (parameter values after loading)
//   8 FORMAT   u32 inst, u32 id, f64 normalized -> UTF-8 display string
//   9 PARSE    u32 inst, u32 id, str text -> f64 normalized (empty if the plug-in can't read it)
//  10 VALUES   u32 inst  -> JSON [{"id":n,"value":v}] (the controller's current parameter values)

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

// ------------------------------------------------------------------ helpers

std::string jsonEscape (const std::string& s)
{
	std::string out;
	out.reserve (s.size () + 2);
	for (unsigned char c : s)
	{
		switch (c)
		{
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (c < 0x20)
				{
					char buf[8];
					snprintf (buf, sizeof (buf), "\\u%04x", c);
					out += buf;
				}
				else
					out += static_cast<char> (c);
		}
	}
	return out;
}

std::string str128 (const String128 s)
{
	return StringConvert::convert (reinterpret_cast<const char16_t*> (s));
}

struct Reader
{
	const uint8_t* p;
	const uint8_t* end;
	bool ok = true;

	template <typename T>
	T get ()
	{
		T v {};
		if (end - p < static_cast<ptrdiff_t> (sizeof (T)))
		{
			ok = false;
			return v;
		}
		std::memcpy (&v, p, sizeof (T));
		p += sizeof (T);
		return v;
	}
	std::string str ()
	{
		auto n = get<uint32_t> ();
		if (!ok || end - p < static_cast<ptrdiff_t> (n))
		{
			ok = false;
			return {};
		}
		std::string s (reinterpret_cast<const char*> (p), n);
		p += n;
		return s;
	}
	const uint8_t* bytes (size_t n)
	{
		if (end - p < static_cast<ptrdiff_t> (n))
		{
			ok = false;
			return nullptr;
		}
		auto r = p;
		p += n;
		return r;
	}
};

// ------------------------------------------------------------------ plug-in instance

struct Instance
{
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> component;
	IPtr<IAudioProcessor> processor;
	IPtr<IEditController> controller;
	HostProcessData data;
	ParameterChanges inChanges {64};
	ParameterChanges outChanges {64};
	int32 inChannels = 2;
	int32 outChannels = 2;
	int32 maxBlock = 4096;
	double sampleRate = 48000;
	std::vector<std::vector<float>> inBuf, outBuf;
	std::vector<float*> inPtr, outPtr;
	bool processing = false;

	~Instance ()
	{
		if (processor && processing)
			processor->setProcessing (false);
		if (component)
			component->setActive (false);
		data.unprepare ();
		controller = nullptr;
		processor = nullptr;
		component = nullptr;
		provider = nullptr;
	}

	bool start (std::string& error)
	{
		processing = false;
		ProcessSetup setup {kRealtime, kSample32, maxBlock, sampleRate};
		if (processor->setupProcessing (setup) != kResultOk)
		{
			error = "setupProcessing failed";
			return false;
		}
		if (component->setActive (true) != kResultOk)
		{
			error = "setActive failed";
			return false;
		}
		processing = processor->setProcessing (true) == kResultOk || true;
		return true;
	}

	void stop ()
	{
		if (processing)
			processor->setProcessing (false);
		component->setActive (false);
		processing = false;
	}
};

std::map<uint32_t, std::unique_ptr<Instance>> instances;

int32 busChannels (IComponent* c, BusDirection dir)
{
	if (c->getBusCount (kAudio, dir) < 1)
		return 0;
	BusInfo info {};
	if (c->getBusInfo (kAudio, dir, 0, info) != kResultOk)
		return 0;
	return info.channelCount;
}

std::unique_ptr<Instance> createInstance (const std::string& path, const std::string& cidHex, double sampleRate,
                                          int32 maxBlock, std::string& error)
{
	auto inst = std::make_unique<Instance> ();
	inst->sampleRate = sampleRate;
	inst->maxBlock = maxBlock;
	inst->module = VST3::Hosting::Module::create (path, error);
	if (!inst->module)
		return nullptr;
	auto factory = inst->module->getFactory ();
	auto uid = VST3::UID::fromString (cidHex);
	for (auto& ci : factory.classInfos ())
	{
		if (ci.category () != kVstAudioEffectClass)
			continue;
		if (uid && *uid != ci.ID ())
			continue;
		inst->provider = owned (new PlugProvider (factory, ci, true));
		break;
	}
	if (!inst->provider)
	{
		error = "No VST3 audio effect with this class id in " + path;
		return nullptr;
	}
	if (!inst->provider->initialize ())
	{
		error = "The plug-in could not be initialised";
		return nullptr;
	}
	inst->component = inst->provider->getComponentPtr ();
	inst->controller = inst->provider->getControllerPtr ();
	inst->processor = U::cast<IAudioProcessor> (inst->component);
	if (!inst->component || !inst->processor)
	{
		error = "The plug-in has no audio processor";
		return nullptr;
	}
	if (inst->processor->canProcessSampleSize (kSample32) != kResultTrue)
	{
		error = "The plug-in does not process 32-bit float audio";
		return nullptr;
	}
	// ask for stereo in/out; keep whatever the plug-in insists on otherwise
	int32 nIn = inst->component->getBusCount (kAudio, kInput);
	int32 nOut = inst->component->getBusCount (kAudio, kOutput);
	std::vector<SpeakerArrangement> ins (nIn, SpeakerArr::kStereo), outs (nOut, SpeakerArr::kStereo);
	inst->processor->setBusArrangements (nIn ? ins.data () : nullptr, nIn, nOut ? outs.data () : nullptr, nOut);
	for (int32 b = 0; b < nIn; ++b)
		inst->component->activateBus (kAudio, kInput, b, b == 0);
	for (int32 b = 0; b < nOut; ++b)
		inst->component->activateBus (kAudio, kOutput, b, b == 0);
	for (int32 b = 0; b < inst->component->getBusCount (kEvent, kInput); ++b)
		inst->component->activateBus (kEvent, kInput, b, false);
	inst->inChannels = busChannels (inst->component, kInput);
	inst->outChannels = busChannels (inst->component, kOutput);
	if (inst->outChannels < 1)
	{
		error = "The plug-in has no audio output";
		return nullptr;
	}
	if (!inst->data.prepare (*inst->component, 0, kSample32))
	{
		error = "Could not prepare the audio buffers";
		return nullptr;
	}
	inst->inBuf.assign (std::max (inst->inChannels, 1), std::vector<float> (maxBlock));
	inst->outBuf.assign (inst->outChannels, std::vector<float> (maxBlock));
	for (auto& b : inst->inBuf)
		inst->inPtr.push_back (b.data ());
	for (auto& b : inst->outBuf)
		inst->outPtr.push_back (b.data ());
	if (inst->inChannels > 0)
		inst->data.setChannelBuffers (kInput, 0, inst->inPtr.data (), inst->inChannels);
	inst->data.setChannelBuffers (kOutput, 0, inst->outPtr.data (), inst->outChannels);
	inst->data.inputParameterChanges = &inst->inChanges;
	inst->data.outputParameterChanges = &inst->outChanges;
	if (!inst->start (error))
		return nullptr;
	return inst;
}

std::string paramsJson (Instance& inst)
{
	std::ostringstream o;
	o << "[";
	bool first = true;
	if (inst.controller)
	{
		int32 n = inst.controller->getParameterCount ();
		for (int32 i = 0; i < n; ++i)
		{
			ParameterInfo pi {};
			if (inst.controller->getParameterInfo (i, pi) != kResultOk)
				continue;
			if (!first)
				o << ",";
			first = false;
			o << "{\"id\":" << pi.id << ",\"title\":\"" << jsonEscape (str128 (pi.title)) << "\",\"units\":\""
			  << jsonEscape (str128 (pi.units)) << "\",\"steps\":" << pi.stepCount
			  << ",\"default\":" << pi.defaultNormalizedValue
			  << ",\"value\":" << inst.controller->getParamNormalized (pi.id) << ",\"flags\":" << pi.flags << "}";
		}
	}
	o << "]";
	return o.str ();
}

std::string valuesJson (Instance& inst)
{
	std::ostringstream o;
	o << "[";
	if (inst.controller)
	{
		int32 n = inst.controller->getParameterCount ();
		for (int32 i = 0; i < n; ++i)
		{
			ParameterInfo pi {};
			if (inst.controller->getParameterInfo (i, pi) != kResultOk)
				continue;
			o << (i ? "," : "") << "{\"id\":" << pi.id << ",\"value\":" << inst.controller->getParamNormalized (pi.id)
			  << "}";
		}
	}
	o << "]";
	return o.str ();
}

void process (Instance& inst, uint32_t frames, const float* l, const float* r, std::vector<uint8_t>& reply)
{
	frames = std::min<uint32_t> (frames, static_cast<uint32_t> (inst.maxBlock));
	if (inst.inChannels >= 2)
	{
		std::memcpy (inst.inPtr[0], l, frames * 4);
		std::memcpy (inst.inPtr[1], r, frames * 4);
		for (int32 c = 2; c < inst.inChannels; ++c)
			std::memset (inst.inPtr[c], 0, frames * 4);
	}
	else if (inst.inChannels == 1)
	{
		for (uint32_t i = 0; i < frames; ++i)
			inst.inPtr[0][i] = 0.5f * (l[i] + r[i]);
	}
	inst.data.numSamples = static_cast<int32> (frames);
	inst.outChanges.clearQueue ();
	if (inst.processor->process (inst.data) != kResultOk)
	{
		// pass audio through untouched if the plug-in refuses this block
		std::memcpy (inst.outPtr[0], l, frames * 4);
		if (inst.outChannels > 1)
			std::memcpy (inst.outPtr[1], r, frames * 4);
	}
	inst.inChanges.clearQueue ();
	const float* ol = inst.outPtr[0];
	const float* orr = inst.outChannels > 1 ? inst.outPtr[1] : inst.outPtr[0];
	size_t at = reply.size ();
	reply.resize (at + frames * 8);
	std::memcpy (reply.data () + at, ol, frames * 4);
	std::memcpy (reply.data () + at + frames * 4, orr, frames * 4);
}

// ------------------------------------------------------------------ I/O

bool readExact (void* buf, size_t n)
{
	auto* p = static_cast<char*> (buf);
	while (n > 0)
	{
		size_t got = std::fread (p, 1, n, stdin);
		if (got == 0)
			return false;
		p += got;
		n -= got;
	}
	return true;
}

void writeReply (uint8_t status, const void* data, size_t n)
{
	uint32_t len = static_cast<uint32_t> (n + 1);
	std::fwrite (&len, 4, 1, stdout);
	std::fwrite (&status, 1, 1, stdout);
	if (n)
		std::fwrite (data, 1, n, stdout);
	std::fflush (stdout);
}

void ok (const std::string& s = {}) { writeReply (0, s.data (), s.size ()); }
void fail (const std::string& s) { writeReply (1, s.data (), s.size ()); }

Instance* find (uint32_t id)
{
	auto it = instances.find (id);
	return it == instances.end () ? nullptr : it->second.get ();
}

int serve ()
{
	std::vector<uint8_t> msg;
	std::vector<uint8_t> reply;
	for (;;)
	{
		uint32_t len = 0;
		if (!readExact (&len, 4))
			return 0; // WavePod closed the pipe
		msg.resize (len);
		if (len && !readExact (msg.data (), len))
			return 0;
		Reader rd {msg.data (), msg.data () + msg.size ()};
		uint8_t op = rd.get<uint8_t> ();
		uint32_t id = rd.get<uint32_t> ();
		switch (op)
		{
			case 1: // CREATE
			{
				double sr = rd.get<double> ();
				uint32_t maxBlock = rd.get<uint32_t> ();
				std::string path = rd.str ();
				std::string cid = rd.str ();
				if (!rd.ok)
				{
					fail ("bad request");
					break;
				}
				std::string error;
				auto inst = createInstance (path, cid, sr, static_cast<int32> (std::max<uint32_t> (maxBlock, 64)), error);
				if (!inst)
				{
					fail (error.empty () ? "could not load plug-in" : error);
					break;
				}
				uint32_t latency = inst->processor->getLatencySamples ();
				std::string json = "{\"latency\":" + std::to_string (latency) + ",\"inputs\":" +
				                   std::to_string (inst->inChannels) + ",\"outputs\":" +
				                   std::to_string (inst->outChannels) + ",\"params\":" + paramsJson (*inst) + "}";
				instances[id] = std::move (inst);
				ok (json);
				break;
			}
			case 2: // DESTROY
				instances.erase (id);
				ok ();
				break;
			case 3: // PARAMS
			{
				auto* inst = find (id);
				if (!inst)
				{
					fail ("no such instance");
					break;
				}
				uint32_t count = rd.get<uint32_t> ();
				for (uint32_t i = 0; i < count && rd.ok; ++i)
				{
					uint32_t pid = rd.get<uint32_t> ();
					double v = rd.get<double> ();
					if (!rd.ok)
						break;
					if (inst->controller)
						inst->controller->setParamNormalized (pid, v);
					int32 qi = 0;
					if (auto* q = inst->inChanges.addParameterData (pid, qi))
					{
						int32 pi = 0;
						q->addPoint (0, v, pi);
					}
				}
				ok ();
				break;
			}
			case 4: // PROCESS
			{
				auto* inst = find (id);
				uint32_t frames = rd.get<uint32_t> ();
				auto* l = reinterpret_cast<const float*> (rd.bytes (frames * 4));
				auto* r = reinterpret_cast<const float*> (rd.bytes (frames * 4));
				if (!inst || !rd.ok)
				{
					fail (!inst ? "no such instance" : "bad request");
					break;
				}
				reply.assign (1, 0);
				process (*inst, frames, l, r, reply);
				uint32_t n = static_cast<uint32_t> (reply.size ());
				std::fwrite (&n, 4, 1, stdout);
				std::fwrite (reply.data (), 1, reply.size (), stdout);
				std::fflush (stdout);
				break;
			}
			case 5: // RESET
			{
				auto* inst = find (id);
				if (!inst)
				{
					fail ("no such instance");
					break;
				}
				std::string error;
				inst->stop ();
				if (!inst->start (error))
					fail (error);
				else
					ok ();
				break;
			}
			case 6: // GETSTATE
			{
				auto* inst = find (id);
				if (!inst)
				{
					fail ("no such instance");
					break;
				}
				auto stream = owned (new MemoryStream ());
				if (inst->component->getState (stream) != kResultOk)
				{
					ok ();
					break;
				}
				writeReply (0, stream->getData (), static_cast<size_t> (stream->getSize ()));
				break;
			}
			case 7: // SETSTATE
			{
				auto* inst = find (id);
				if (!inst)
				{
					fail ("no such instance");
					break;
				}
				size_t n = static_cast<size_t> (rd.end - rd.p);
				auto load = [&] () {
					auto s1 = owned (new MemoryStream (const_cast<uint8_t*> (rd.p), static_cast<TSize> (n)));
					inst->component->setState (s1);
					if (inst->controller)
					{
						auto s2 = owned (new MemoryStream (const_cast<uint8_t*> (rd.p), static_cast<TSize> (n)));
						inst->controller->setComponentState (s2);
					}
				};
				inst->stop ();
				load ();
				std::string error;
				inst->start (error);
				ok (valuesJson (*inst));
				break;
			}
			case 8: // FORMAT
			{
				auto* inst = find (id);
				uint32_t pid = rd.get<uint32_t> ();
				double v = rd.get<double> ();
				String128 s {};
				if (!inst || !inst->controller || inst->controller->getParamStringByValue (pid, v, s) != kResultOk)
				{
					ok ();
					break;
				}
				ok (str128 (s));
				break;
			}
			case 9: // PARSE
			{
				auto* inst = find (id);
				uint32_t pid = rd.get<uint32_t> ();
				std::string text = rd.str ();
				if (!inst || !inst->controller || !rd.ok)
				{
					ok ();
					break;
				}
				std::u16string wide = StringConvert::convert (text);
				String128 s {};
				size_t n = std::min (wide.size (), static_cast<size_t> (127));
				std::memcpy (s, wide.data (), n * sizeof (char16_t));
				ParamValue v = 0;
				if (inst->controller->getParamValueByString (pid, s, v) != kResultOk)
				{
					ok ();
					break;
				}
				std::string out (sizeof (double), '\0');
				double d = v;
				std::memcpy (out.data (), &d, sizeof (double));
				ok (out);
				break;
			}
			case 10: // VALUES
			{
				auto* inst = find (id);
				if (!inst)
				{
					fail ("no such instance");
					break;
				}
				ok (valuesJson (*inst));
				break;
			}
			default:
				fail ("unknown op");
		}
	}
}

int scanModule (const std::string& path)
{
	std::string error;
	auto module = VST3::Hosting::Module::create (path, error);
	if (!module)
	{
		std::cerr << error << std::endl;
		std::cout << "[]" << std::endl;
		return 1;
	}
	std::ostringstream o;
	o << "[";
	bool first = true;
	for (auto& ci : module->getFactory ().classInfos ())
	{
		if (ci.category () != kVstAudioEffectClass)
			continue;
		if (!first)
			o << ",";
		first = false;
		o << "{\"path\":\"" << jsonEscape (path) << "\",\"cid\":\"" << ci.ID ().toString () << "\",\"name\":\""
		  << jsonEscape (ci.name ()) << "\",\"vendor\":\"" << jsonEscape (ci.vendor ()) << "\",\"version\":\""
		  << jsonEscape (ci.version ()) << "\",\"categories\":\"" << jsonEscape (ci.subCategoriesString ()) << "\"}";
	}
	o << "]";
	std::cout << o.str () << std::endl;
	return 0;
}

} // namespace

// The SDK's hosting code expects a plug-in context (host application object).
static HostApplication* gHost = nullptr;

int run (const std::vector<std::string>& args)
{
	gHost = new HostApplication ();
	PluginContextFactory::instance ().setPluginContext (gHost);
	PlugProvider::setErrorStream (&std::cerr);
	if (args.size () >= 2 && args[0] == "--scan-module")
		return scanModule (args[1]);
	if (!args.empty () && args[0] == "--serve")
	{
#if defined(_WIN32)
		_setmode (_fileno (stdin), _O_BINARY);
		_setmode (_fileno (stdout), _O_BINARY);
#endif
		int rc = serve ();
		instances.clear ();
		return rc;
	}
	std::cerr << "usage: wavepod-vsthost --serve | --scan-module <path.vst3>" << std::endl;
	return 2;
}

#if defined(_WIN32)
int wmain (int argc, wchar_t* argv[])
{
	std::vector<std::string> args;
	for (int i = 1; i < argc; ++i)
		args.push_back (StringConvert::convert (reinterpret_cast<const char16_t*> (argv[i])));
	return run (args);
}
#else
int main (int argc, char* argv[])
{
	std::vector<std::string> args (argv + 1, argv + argc);
	return run (args);
}
#endif
