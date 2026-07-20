import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export function ModalDialog({
  label,
  children,
  cancelDisabled,
  onCancel
}: {
  label: string;
  children: ReactNode;
  cancelDisabled: boolean;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      focusableDialogElements(dialogRef.current)[0]?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (returnTarget?.isConnected === true) returnTarget.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!cancelDisabled) return;
    const focusable = focusableDialogElements(dialog);
    if (!focusable.some((element) => element === document.activeElement)) {
      // Privileged mutations can disable the currently focused action. Move to another enabled
      // control, or the dialog itself, so Tab cannot escape while the request is in flight.
      (focusable[0] ?? dialog)?.focus();
    }
  }, [cancelDisabled]);

  const trapFocus = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = focusableDialogElements(dialogRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !cancelDisabled) {
          event.preventDefault();
          onCancel();
          return;
        }
        trapFocus(event);
      }}
    >
      {children}
    </div>
  );
}

function focusableDialogElements(dialog: HTMLDivElement | null): HTMLElement[] {
  if (dialog === null) return [];
  // Dialog focus must stay on interactive, enabled controls; hidden or disabled actions cannot be
  // safe focus targets while a privileged operation is in flight.
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.getClientRects().length > 0);
}
