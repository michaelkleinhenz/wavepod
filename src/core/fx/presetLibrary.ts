// All presets for a filter in one place: WavePod's factory presets, a VST3 plug-in's own programs
// and the user's saved presets. Used by the FX panel (over IPC) and by the MCP tools.
import type { Fx } from '../../shared/types';
import {
  MAX_PROGRAMS,
  applyPreset,
  applyProgram,
  factoryPreset,
  factoryPresets,
  paramSignature,
  presetFromFx,
  programId,
  programIndex,
  type FxPreset,
  type FxPresetEntry,
} from './presets';
import { vstProgramParam } from './vst';

export interface PresetStorage {
  list(fx: Fx): FxPresetEntry[] | Promise<FxPresetEntry[]>;
  load(id: string): FxPreset | Promise<FxPreset>;
  save(preset: FxPreset): (FxPresetEntry & { replaced: boolean }) | Promise<FxPresetEntry & { replaced: boolean }>;
}

/** A VST3 plug-in's own programs, read through the plug-in host. */
export interface ProgramHost {
  /** Display names of the program selector's values. */
  names(fx: Fx, paramId: number, steps: number): string[] | Promise<string[]>;
  /** Selects a program on a scratch instance and reads back the resulting state and values. */
  load(fx: Fx, paramId: number, value: number): { state: string; values: Array<{ id: number; value: number }> } | Promise<{ state: string; values: Array<{ id: number; value: number }> }>;
}

export interface FxPresetLibrary {
  /** Factory presets (or the plug-in's programs) first, then the user's. */
  list(fx: Fx): Promise<FxPresetEntry[]>;
  /** The filter set to a preset from `list`. */
  apply(fx: Fx, id: string): Promise<Fx>;
  /** Saves the filter's settings as a user preset; returns the filter now marked with it. */
  save(fx: Fx, name: string): Promise<{ entry: FxPresetEntry; replaced: boolean; fx: Fx }>;
}

export function createPresetLibrary(storage: PresetStorage, programs: ProgramHost | null): FxPresetLibrary {
  const programNames = async (fx: Fx): Promise<string[]> => {
    const param = vstProgramParam(fx.paramInfo ?? []);
    if (!param || !programs) return [];
    try {
      const steps = Math.min(param.steps, MAX_PROGRAMS - 1);
      const names = await programs.names(fx, param.id, steps);
      return names.map((n, i) => n.trim() || `Program ${i + 1}`);
    } catch {
      return []; // the plug-in failed to load; its programs are just not offered
    }
  };

  return {
    async list(fx) {
      const factory: FxPresetEntry[] =
        fx.type === 'vst3'
          ? (await programNames(fx)).map((name, i) => ({ id: programId(i), name, source: 'program' as const }))
          : factoryPresets(fx.type).map(({ id, preset, description }) => ({ id, name: preset.name, source: 'factory' as const, description }));
      return [...factory, ...(await storage.list(fx))];
    },

    async apply(fx, id) {
      const index = programIndex(id);
      if (index !== null) {
        const param = vstProgramParam(fx.paramInfo ?? []);
        if (fx.type !== 'vst3' || !param || !programs) throw new Error('This filter has no programs of its own.');
        if (index > param.steps) throw new Error(`There is no program ${index + 1}.`);
        const names = await programNames(fx);
        const loaded = await programs.load(fx, param.id, index / param.steps);
        return applyProgram(fx, loaded, { id, name: names[index] ?? `Program ${index + 1}` });
      }
      const factory = factoryPreset(id);
      if (factory) return applyPreset(fx, factory, { id, name: factory.name });
      const preset = await storage.load(id);
      return applyPreset(fx, preset, { id, name: preset.name });
    },

    async save(fx, name) {
      const saved = await storage.save(presetFromFx(fx, name));
      const { replaced, ...entry } = saved;
      return { entry, replaced, fx: { ...fx, preset: { id: entry.id, name: entry.name, sig: paramSignature(fx.params) } } };
    },
  };
}
