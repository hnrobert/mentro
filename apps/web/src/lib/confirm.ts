import { defineComponent, h, ref } from "vue";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle,
} from "reka-ui";
import AlertDialog from "@/components/ui/alert-dialog/AlertDialog.vue";
import Button from "@/components/ui/Button.vue";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

interface Pending {
  resolve: (ok: boolean) => void;
  options: ConfirmOptions;
}

const pending = ref<Pending | null>(null);

/** Promise-based confirmation dialog (replaces window.confirm). Mount
 *  <ConfirmHost /> once (App.vue); call sites simply await. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    pending.value = { resolve, options };
  });
}

export const ConfirmHost = defineComponent({
  name: "ConfirmHost",
  setup() {
    function done(ok: boolean): void {
      pending.value?.resolve(ok);
      pending.value = null;
    }
    return () => {
      const p = pending.value;
      if (!p) return null;
      const o = p.options;
      return h(
        AlertDialog,
        { open: true, "onUpdate:open": (v: boolean) => !v && done(false) },
        () => [
          h(
            AlertDialogTitle,
            { class: "text-base font-semibold" },
            () => o.title,
          ),
          o.description
            ? h(
                AlertDialogDescription,
                { class: "text-sm leading-relaxed text-muted-foreground" },
                () => o.description,
              )
            : null,
          h("div", { class: "flex justify-end gap-2" }, () => [
            h(
              AlertDialogCancel,
              { asChild: true, onClick: () => done(false) },
              () =>
                h(
                  Button,
                  { variant: "outline", size: "sm" },
                  () => o.cancelText ?? "Cancel",
                ),
            ),
            h(
              AlertDialogAction,
              { asChild: true, onClick: () => done(true) },
              () =>
                h(
                  Button,
                  {
                    size: "sm",
                    class: o.destructive
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : "",
                  },
                  () => o.confirmText ?? "Confirm",
                ),
            ),
          ]),
        ],
      );
    };
  },
});
