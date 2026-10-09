import type { DelegatedThreadState } from "@t3tools/client-runtime/state/delegated-threads";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  HandIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

export const STATE_PRESENTATION: Record<
  DelegatedThreadState,
  { readonly icon: LucideIcon; readonly label: string; readonly className: string }
> = {
  preparing: {
    icon: CircleDashedIcon,
    label: "Setting up",
    className: "text-muted-foreground",
  },
  running: { icon: CircleDotIcon, label: "Working", className: "text-info" },
  waiting: { icon: HandIcon, label: "Needs input", className: "text-warning" },
  done: { icon: CircleCheckIcon, label: "Done", className: "text-success" },
  failed: { icon: CircleXIcon, label: "Failed", className: "text-destructive" },
  stopped: { icon: CircleSlashIcon, label: "Stopped", className: "text-muted-foreground" },
};

export function DelegatedThreadStateIcon(props: {
  readonly state: DelegatedThreadState;
  readonly className?: string;
}) {
  const presentation = STATE_PRESENTATION[props.state];
  const StateIcon = presentation.icon;
  return (
    <StateIcon
      aria-label={presentation.label}
      className={cn("shrink-0", presentation.className, props.className)}
    />
  );
}
