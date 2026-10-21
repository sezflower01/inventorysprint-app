/**
 * Privacy gate for the Inventory Valuation summary card.
 *
 * WHY THIS EXISTS. The valuation block puts total stock value, cost basis,
 * projected sale and ROI on screen in one glance. On a desktop that an
 * employee may walk up to or borrow, that is the whole financial position of
 * the business sitting in the open. The seller asked for it hidden by default
 * there, behind a code they can type to reveal it.
 *
 * DESKTOP ONLY, ON PURPOSE. The phone is the owner's own device and is used
 * one-handed while working; gating it there would be friction with no privacy
 * gained. SyncedInventory renders two separate valuation cards -- a `md:hidden`
 * mobile one and a `hidden md:block` desktop one -- so this gate wraps only
 * the desktop card and the caller passes the breakpoint class in `className`.
 * The breakpoint must live on the gate's own wrapper, not on the card inside
 * it: if it sat inside, the locked placeholder would render on phones too and
 * you would see it stacked above the mobile card.
 *
 * WHAT THIS IS NOT. The code is a constant in the bundle. Anyone who opens
 * devtools, reads the JS, or queries the database directly can get the numbers
 * regardless. This is a shoulder-surfing screen -- it stops a glance, a
 * screen-share and a photo. It is NOT access control, and it must never be
 * relied on as one; real restriction belongs in RLS and the module-access
 * guards, where it would also cover the API rather than just the pixels.
 *
 * RE-LOCKING. The unlock is kept in sessionStorage, not localStorage. A
 * localStorage flag would leave the figures permanently exposed on that
 * machine after one unlock, which defeats the point; sessionStorage drops the
 * unlock when the tab closes, so a fresh window starts locked again. There is
 * also an explicit Hide control for re-locking on the spot -- the case where
 * someone is about to look over your shoulder is exactly when you cannot wait
 * for a tab to close.
 */
import { useCallback, useEffect, useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";
// The code, the storage key and the fail-closed read live in src/lib so they
// can be unit-tested -- this repo has Vitest but no jsdom, so the component
// itself cannot be rendered in a test while those functions can.
// See src/lib/__tests__/valuationPrivacy.test.ts.
import {
  CODE_LENGTH,
  getUnlockStorage,
  isRevealCode,
  readStoredUnlock,
  writeStoredUnlock,
} from "@/lib/valuationPrivacy";

interface ValuationPrivacyGateProps {
  children: React.ReactNode;
  /**
   * Classes for the gate's own wrapper -- the caller passes the breakpoint
   * (`hidden md:block`) here so the locked placeholder is desktop-only too.
   */
  className?: string;
}

export function ValuationPrivacyGate({ children, className }: ValuationPrivacyGateProps) {
  const [revealed, setRevealed] = useState<boolean>(() => readStoredUnlock(getUnlockStorage()));
  const [promptOpen, setPromptOpen] = useState(false);
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    // Non-fatal when this fails: the gate still honours `revealed` for this
    // view, it just will not remember the unlock across a navigation.
    writeStoredUnlock(getUnlockStorage(), revealed);
  }, [revealed]);

  const submit = useCallback((value: string) => {
    if (isRevealCode(value)) {
      setRevealed(true);
      setPromptOpen(false);
      setCode("");
      setWrong(false);
    } else {
      setWrong(true);
      setCode("");
    }
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setCode(value);
      if (wrong) setWrong(false);
      // Auto-submit on the last digit: a four-digit code does not need a
      // separate confirm press.
      if (value.length === CODE_LENGTH) submit(value);
    },
    [submit, wrong],
  );

  const openPrompt = useCallback(() => {
    setCode("");
    setWrong(false);
    setPromptOpen(true);
  }, []);

  return (
    <>
      <div className={className}>
        {/* A fixed-height control row ABOVE the card, not a button floated
            over it.
            The first version of this put Hide at `absolute top-1.5 right-1.5`
            inside the card. That corner is not empty: the desktop card is a
            horizontal row of tiles ending in Projected Margin, whose 10px
            label sits exactly there. With the card's px-5 padding, a ~46px
            button 6px from the edge would have covered about 30px of that
            column -- and the one moment this control matters is when someone
            is walking over, which is the worst moment to be hunting for a
            label-obscuring ghost button.
            The row keeps its height in BOTH states so revealing and hiding
            never shift the page. It is empty while locked, because the locked
            placeholder carries its own Reveal button as the obvious action. */}
        <div className="flex items-center justify-end h-7">
          {revealed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRevealed(false)}
              className="h-7 gap-1.5 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              title="Hide these figures again"
            >
              <EyeOff className="h-3.5 w-3.5" />
              Hide figures
            </Button>
          )}
        </div>
        {revealed ? (
          children
        ) : (
          /* Matches the real card's shape -- same rounded-2xl, border and
             px-5 py-4 -- so revealing it does not shift the page. Visually
             quieter than the real card (no gradient glow, muted icon) so it
             reads as "nothing here" rather than as a broken panel. */
          <div className="relative bg-card border border-border/50 rounded-2xl px-5 py-4 shadow-xl backdrop-blur-sm">
            <div className="flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center shadow-inner shrink-0">
                <Lock className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Valuation hidden
                </span>
                <span className="text-sm font-medium text-foreground leading-tight">
                  Figures are hidden on desktop for privacy
                </span>
                <span className="text-[10px] text-muted-foreground">
                  Enter your code to reveal them for this tab
                </span>
              </div>
              <div className="ml-auto shrink-0">
                <Button type="button" variant="outline" size="sm" onClick={openPrompt} className="gap-1.5">
                  <Eye className="h-3.5 w-3.5" />
                  Reveal
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-muted-foreground" />
              Reveal valuation
            </DialogTitle>
            <DialogDescription className="text-xs">
              The figures stay visible until you hide them or close this tab.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <InputOTP
              maxLength={CODE_LENGTH}
              value={code}
              onChange={handleChange}
              autoFocus
              // Numeric only: the code is digits, and this also brings up the
              // number pad rather than a full keyboard.
              inputMode="numeric"
              pattern="[0-9]*"
            >
              <InputOTPGroup>
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className={cn(wrong && "border-destructive text-destructive")}
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {/* aria-live so the failure is announced, not only coloured. */}
            <span
              aria-live="polite"
              className={cn(
                "text-xs min-h-4",
                wrong ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {wrong ? "Wrong code — try again" : ""}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
