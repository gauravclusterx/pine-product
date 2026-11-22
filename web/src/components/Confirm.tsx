/** In-app confirmation dialog (never the browser's confirm()). const ok = await confirm({ title, body }). */
import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import { Modal } from "./ui";

interface Ask { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
type ConfirmFn = (a: Ask) => Promise<boolean>;
const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback<ConfirmFn>((a) => new Promise<boolean>((resolve) => { resolver.current = resolve; setAsk(a); }), []);
  const close = (v: boolean) => { resolver.current?.(v); resolver.current = null; setAsk(null); };
  return (
    <Ctx.Provider value={confirm}>
      {children}
      {ask && (
        <Modal open onClose={() => close(false)} title={ask.title}>
          {ask.body && <div className="text-sm text-ink-soft leading-relaxed">{ask.body}</div>}
          <div className="flex justify-end gap-2 mt-6">
            <button className="btn-ghost" onClick={() => close(false)}>{ask.cancelLabel || "Cancel"}</button>
            <button className={ask.danger ? "btn h-10 bg-bad text-[#0B1409] hover:brightness-110" : "btn-primary"} onClick={() => close(true)} autoFocus>{ask.confirmLabel || "Confirm"}</button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConfirm outside ConfirmProvider");
  return c;
}
