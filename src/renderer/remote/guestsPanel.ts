// View › Remote Guests: a floating panel (it stays open while recording, so the host can see the
// guests and their uploads). Invite guests, let them in from the waiting room, see who is talking,
// how the connection is, whether their recording has reached this computer, and, if video is on,
// see each other (video is only for eye contact and is never recorded).
import { clear, errorMessage, h, toast } from '../dom';
import { api, store } from '../store';
import { remoteSession, type GuestState } from './session';
import type { RemoteTakeInfo, Track } from '../../shared/types';
import { guestIdentity } from '../../shared/remoteProtocol';

export class GuestsPanel {
  private el = h('div', { class: 'remote-panel', role: 'dialog', 'aria-label': 'Remote guests' });
  private nameDraft = '';
  private configured: boolean | null = null;
  private onSettings: () => void;

  constructor(openSettings: () => void) {
    this.onSettings = openSettings;
    remoteSession.subscribe(() => this.render());
    store.subscribe((kinds) => {
      if (this.isOpen && kinds.has('project')) this.render();
    });
  }

  get isOpen(): boolean {
    return this.el.isConnected;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    document.body.append(this.el);
    this.render();
    try {
      const info = await api().getRemoteSettings();
      this.configured = !!(info.url && info.apiKey && info.hasSecret);
    } catch {
      this.configured = false;
    }
    this.render();
  }

  close(): void {
    this.el.remove();
  }

  private remoteTracks(): Track[] {
    return store.project.tracks.filter((t) => t.remote);
  }

  private render(): void {
    if (!this.isOpen) return;
    // the panel redraws as guests talk; keep the cursor in the name field
    const typing = document.activeElement instanceof HTMLInputElement && this.el.contains(document.activeElement) ? document.activeElement.selectionStart : null;
    this.draw();
    if (typing !== null) {
      const input = this.el.querySelector<HTMLInputElement>('.remote-invite input');
      input?.focus();
      input?.setSelectionRange(typing, typing);
    }
  }

  private draw(): void {
    clear(this.el);
    const s = remoteSession;
    const head = h(
      'div',
      { class: 'remote-head' },
      h('h3', null, 'Remote guests'),
      s.connected ? h('span', { class: 'remote-badge live' }, 'Session open') : null,
      h('button', { class: 'icon-close', title: 'Close (the session keeps running)', onclick: () => this.close() }, '×'),
    );
    this.el.append(head);
    if (this.configured === false) {
      this.el.append(
        h('p', { class: 'muted' }, 'Remote guests need a LiveKit server: a free LiveKit Cloud project or your own. Enter its URL, API key and secret first.'),
        h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: () => this.onSettings() }, 'Open Settings')),
      );
      return;
    }
    if (s.error) this.el.append(h('p', { class: 'remote-error' }, s.error));
    if (!s.connected) {
      this.el.append(
        h('p', { class: 'muted' }, 'Open the session so invited guests can join. They wait until you let them in.'),
        h('div', { class: 'row end' }, h('button', { class: 'primary', disabled: s.connecting, onclick: () => void s.start() }, s.connecting ? 'Connecting…' : 'Open Session')),
      );
    }
    const list = h('div', { class: 'remote-guests' });
    for (const t of this.remoteTracks()) list.append(this.guestRow(t));
    // guests in the room whose track was deleted
    for (const g of s.guests.values()) {
      if (!this.remoteTracks().some((t) => t.remote!.guestId === g.guestId)) list.append(this.strayRow(g));
    }
    if (!list.childElementCount) list.append(h('p', { class: 'muted' }, 'No guests invited yet.'));
    this.el.append(list);
    const input = h('input', {
      type: 'text',
      placeholder: 'Guest name',
      value: this.nameDraft,
      oninput: (e: Event) => (this.nameDraft = (e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void this.invite();
        e.stopPropagation();
      },
    });
    this.el.append(h('div', { class: 'row remote-invite' }, input, h('button', { onclick: () => void this.invite() }, 'Invite')));
    if (s.connected) {
      const foot = h('div', { class: 'row end remote-foot' });
      if (s.video) foot.append(h('button', { onclick: () => void s.setCamera(!s.cameraOn).catch((e) => toast(errorMessage(e), 'error')) }, s.cameraOn ? 'Camera off' : 'Camera on'));
      foot.append(h('button', { onclick: () => void s.stop() }, 'End Session'));
      if (s.localVideo) {
        s.localVideo.classList.add('remote-video', 'self');
        this.el.append(s.localVideo);
      }
      this.el.append(foot);
    }
  }

  private guestRow(t: Track): HTMLElement {
    const identity = guestIdentity(t.remote!.guestId);
    const g = remoteSession.guests.get(identity);
    const takes = remoteSession.takes.filter((x) => x.trackId === t.id);
    const status = !remoteSession.connected ? '' : !g ? 'Not here yet' : g.status === 'waiting' ? 'Waiting to be let in' : 'Live';
    const actions = h('div', { class: 'remote-actions' });
    actions.append(h('button', { title: 'Copy a fresh invite link', onclick: () => void this.copyLink(t) }, 'Copy Link'));
    if (g && g.status === 'waiting') actions.append(h('button', { class: 'primary', onclick: () => void remoteSession.admit(identity).catch((e) => toast(errorMessage(e), 'error')) }, 'Let In'));
    if (g && g.status === 'live') actions.append(h('button', { onclick: () => void remoteSession.holdBack(identity).catch((e) => toast(errorMessage(e), 'error')) }, 'Hold Back'));
    if (g) actions.append(h('button', { onclick: () => void remoteSession.remove(identity).catch((e) => toast(errorMessage(e), 'error')) }, 'Remove'));
    const row = h(
      'div',
      { class: `remote-guest${g?.speaking ? ' speaking' : ''}` },
      h('span', { class: 'remote-dot', style: `background:${t.color}` }),
      h(
        'div',
        { class: 'remote-guest-main' },
        h('div', { class: 'remote-name' }, t.name, status ? h('span', { class: `remote-status ${g?.status ?? 'away'}` }, status) : null),
        g ? h('div', { class: 'remote-meta muted' }, this.meta(g)) : null,
        g?.problem ? h('div', { class: 'remote-error' }, g.problem) : null,
        takes.length ? h('div', { class: 'remote-meta muted' }, this.uploads(takes)) : null,
      ),
      actions,
    );
    if (g?.video) {
      g.video.classList.add('remote-video');
      row.append(g.video);
    }
    return row;
  }

  private strayRow(g: GuestState): HTMLElement {
    return h(
      'div',
      { class: 'remote-guest' },
      h('div', { class: 'remote-guest-main' }, h('div', { class: 'remote-name' }, g.name, h('span', { class: 'remote-status away' }, 'No track'))),
      h('div', { class: 'remote-actions' }, h('button', { onclick: () => void remoteSession.remove(g.identity) }, 'Remove')),
    );
  }

  private meta(g: GuestState): string {
    const parts: string[] = [];
    if (g.rttMs !== null) parts.push(`${g.rttMs} ms round trip`);
    if (g.quality !== 'unknown') parts.push(`connection ${g.quality}`);
    if (g.storage === 'none') parts.push('browser can’t store the recording');
    else if (g.storage === 'full') parts.push('browser storage full');
    if (g.behind > 2) parts.push(`upload ${g.behind} s behind`);
    return parts.join(' · ');
  }

  private uploads(takes: RemoteTakeInfo[]): string {
    const last = takes[takes.length - 1];
    // a guest who reopened the page mid-take sends the rest as another part of the same take
    const n = new Set(takes.map((t) => t.takeId.split('-p')[0])).size;
    const state =
      last.state === 'placed'
        ? (last.note ?? 'Local recording on the timeline')
        : last.state === 'complete'
          ? 'Local recording complete; goes on the timeline when recording stops'
          : last.state === 'uploading'
            ? `Local recording arriving: ${last.received}${last.chunks !== null ? ` of ${last.chunks}` : ''} s`
            : `Recording locally, ${last.received} s received`;
    return n > 1 ? `Take ${n}: ${state}` : state;
  }

  private async invite(): Promise<void> {
    const name = this.nameDraft.trim();
    if (!name) return toast('Type the guest’s name first');
    try {
      const { link } = await api().remoteInvite(name);
      this.nameDraft = '';
      await navigator.clipboard.writeText(link).catch(() => {});
      toast(`Invite link for ${name} copied. Send it to them.`);
      this.render();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private async copyLink(t: Track): Promise<void> {
    try {
      const link = await api().remoteLink(t.id);
      await navigator.clipboard.writeText(link);
      toast(`Invite link for ${t.name} copied`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }
}
