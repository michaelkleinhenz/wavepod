// Click-to-type for the number next to a slider: the value text turns into a field, Enter or
// leaving the field applies what was typed (clamped to the slider's range), Escape cancels.
import { parseNumberInput, type NumberInputSpec } from '../core/numberInput';

export interface EditableValueOptions {
  /** Text the field starts with: the current value, without its unit. */
  initial: () => string;
  /** Reads typed text; null when it isn't a usable value (the edit is then dropped). */
  parse: (text: string) => number | null | Promise<number | null>;
  /** Applies the typed value (as one undo step). */
  commit: (value: number) => void;
  /** Called after the field closes, whether or not a value was applied. */
  onClose?: () => void;
}

let editing: HTMLInputElement | null = null;

/** True while a value field inside `container` (anywhere, without one) is being typed into. */
export function isEditingValue(container?: Element): boolean {
  return !!editing && editing.isConnected && (!container || container.contains(editing));
}

/** Makes `display` (the element showing a slider's value) click-to-type. Returns `display`. */
export function editableValue<T extends HTMLElement>(display: T, opts: EditableValueOptions): T {
  display.classList.add('editable-value');
  display.tabIndex = 0;
  if (!display.title) display.title = 'Click to type a value';
  // the value often sits inside a <label>: keep the click from reaching its slider
  display.addEventListener('mousedown', (e) => e.preventDefault());
  display.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(display, opts);
  });
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      open(display, opts);
    }
  });
  return display;
}

/** Shorthand for a plain numeric slider: parses with the slider's range, unit and precision. */
export function editableNumber<T extends HTMLElement>(
  display: T,
  spec: NumberInputSpec & { get: () => number; commit: (value: number) => void; onClose?: () => void },
): T {
  return editableValue(display, {
    initial: () => formatPlain(spec.get(), spec.precision),
    parse: (text) => parseNumberInput(text, spec),
    commit: spec.commit,
    onClose: spec.onClose,
  });
}

/** A value as typed into the field: no unit, no "+", only the digits the precision allows. */
export function formatPlain(v: number, precision?: number): string {
  if (!precision || precision <= 0) return String(Number(v.toFixed(6)));
  const digits = Math.max(0, Math.ceil(-Math.log10(precision) - 1e-9));
  return String(Number(v.toFixed(digits)));
}

function open(display: HTMLElement, opts: EditableValueOptions): void {
  if (!display.isConnected || display.dataset.editing) return;
  display.dataset.editing = '1';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'value-edit';
  input.value = opts.initial();
  input.spellcheck = false;
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('aria-label', 'Value');
  let done = false;
  const close = async (apply: boolean) => {
    if (done) return;
    done = true;
    const text = input.value;
    if (editing === input) editing = null;
    input.replaceWith(display);
    delete display.dataset.editing;
    if (apply && text.trim() && text !== opts.initial()) {
      try {
        const v = await opts.parse(text);
        if (v !== null && Number.isFinite(v)) opts.commit(v);
      } catch {
        // unreadable: keep the old value
      }
    }
    opts.onClose?.();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void close(false);
    }
  });
  input.addEventListener('blur', () => void close(true));
  // keep clicks in the field away from handlers of the surrounding row (drag grips etc.)
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  display.replaceWith(input);
  editing = input;
  input.focus();
  input.select();
}
