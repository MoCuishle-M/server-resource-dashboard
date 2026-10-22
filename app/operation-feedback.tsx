"use client";
import { createContext, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

export type OperationNotice = {
  message: string;
  kind: "success" | "error";
  dialog: HTMLDialogElement | null;
};

export const FeedbackContext = createContext<{
  notice: OperationNotice | null;
  setNotice: Dispatch<SetStateAction<OperationNotice | null>>;
} | null>(null);

export function activeDialog(): HTMLDialogElement | null {
  return document.activeElement?.closest<HTMLDialogElement>("dialog[open]")
    ?? document.querySelector<HTMLDialogElement>("dialog:modal");
}

export function OperationFeedback({ notice, onClose, insideDialog = false }: {
  notice: OperationNotice;
  onClose: () => void;
  insideDialog?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice.kind !== "error") return;
    ref.current?.focus({ preventScroll: true });
    if (insideDialog) ref.current?.scrollIntoView({ block: "start" });
  }, [notice, insideDialog]);
  return <div ref={ref} className={`operation-feedback ${insideDialog ? "modal-feedback" : "toast"} ${notice.kind}`}
    role={notice.kind === "error" ? "alert" : "status"} tabIndex={-1}>
    {notice.kind === "error" ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
    <div>{notice.kind === "error" && <strong>操作未完成</strong>}<p>{notice.message}</p></div>
    <button type="button" aria-label="关闭提示" onClick={onClose}><X size={18} /></button>
  </div>;
}
