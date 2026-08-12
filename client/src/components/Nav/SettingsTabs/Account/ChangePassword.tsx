import React, { useRef, useState, useEffect, useCallback } from 'react';
import { KeyRound } from 'lucide-react';
import {
  OGDialogContent,
  OGDialogTrigger,
  OGDialogHeader,
  OGDialogTitle,
  useToastContext,
  OGDialog,
  Spinner,
  Button,
  Label,
  Input,
} from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
/**
 * UD Assistant customization: in-session password change.
 *
 * Accounts here are admin-created and `ALLOW_PASSWORD_RESET=false` (no SMTP),
 * so upstream's email-link reset flow is unavailable. This is the logged-in
 * equivalent — prove you know the current password, set a new one.
 *
 * NOT a recovery path: a user who has forgotten their password still needs an
 * admin to reset it. Say so in onboarding so people don't hunt for a reset link
 * that doesn't exist.
 *
 * Strings are hardcoded English rather than localize() keys because the beta is
 * English-only (the language selector is disabled in the settings registry).
 */
const MIN_LENGTH = 8;

const ChangePassword = ({ disabled = false }: { title?: string; disabled?: boolean }) => {
  const { showToast } = useToastContext();
  const { user } = useAuthContext();
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);

  /**
   * Chrome's autofill writes to the DOM without firing React's onChange, so state
   * stays '' while the field visibly shows a value — validation then blocks a user
   * whose password manager just filled the form correctly. Read the live values back.
   *
   * getElementById rather than refs: OGDialogContent portals its children and the
   * Input component's ref forwarding isn't guaranteed, whereas the ids always resolve.
   * These inputs are controlled, so the DOM matches state except when autofill
   * diverges — reading it is always safe.
   */
  const syncFromDom = useCallback(() => {
    const read = (id: string) =>
      (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
    setCurrent(read('current-password-input'));
    setNext(read('new-password-input'));
    setConfirm(read('confirm-password-input'));
  }, []);
  const reset = useCallback(() => {
    setCurrent('');
    setNext('');
    setConfirm('');
  }, []);
  /** Autofill lands some milliseconds after mount, and the exact delay varies. */
  useEffect(() => {
    if (!isDialogOpen) {
      return;
    }
    const timers = [50, 250, 750].map((ms) => window.setTimeout(syncFromDom, ms));
    return () => timers.forEach(window.clearTimeout);
  }, [isDialogOpen, syncFromDom]);
  /** Mirrors the server's checks so the user gets feedback before a round-trip. */
  const localError = (() => {
    if (!current || !next || !confirm) {
      return 'All three fields are required.';
    }
    if (next.length < MIN_LENGTH) {
      return `New password must be at least ${MIN_LENGTH} characters.`;
    }
    if (next !== confirm) {
      return 'The new passwords do not match.';
    }
    if (next === current) {
      return 'New password must differ from the current one.';
    }
    return null;
  })();

  const handleSubmit = async () => {
    if (localError || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      await dataService.changePassword({ currentPassword: current, newPassword: next });
      showToast({ message: 'Password updated.', status: 'success' });
      reset();
      setDialogOpen(false);
    } catch (error: any) {
      // The server distinguishes a wrong current password (401) from validation
      // failures (400) — surface its message rather than a generic one.
      const message =
        error?.response?.data?.message ?? 'Could not update the password. Please try again.';
      showToast({ message, status: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const onOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      reset();
    }
  };

  return (
    <OGDialog open={isDialogOpen} onOpenChange={onOpenChange} triggerRef={buttonRef}>
      <div className="flex items-center justify-between">
        <Label id="change-password-label">Password</Label>
        <Button
          ref={buttonRef}
          type="button"
          aria-labelledby="change-password-label"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={disabled}
        >
          Change
        </Button>
      </div>

      <OGDialogContent 
        className="w-11/12 max-w-md"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false">
        {/*
          Decoy username field. Chrome autofills a username alongside any password
          input; with no autocomplete="username" target in the dialog it fills the
          settings search box instead, which filters this row out of the list and
          unmounts the dialog. Must be rendered (not display:none) or Chrome skips it.
        */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user?.email ?? ''}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />    
        <OGDialogHeader>
          <OGDialogTitle className="text-lg font-medium leading-6">
            Change your password
          </OGDialogTitle>
        </OGDialogHeader>

        <div className="flex flex-col gap-4" onFocus={syncFromDom}>
          <div>
            <label
              className="mb-1 block text-sm font-medium text-black dark:text-white"
              htmlFor="current-password-input"
            >
              Current password
            </label>
            <Input
              id="current-password-input"
              type="password"
              autoComplete="new-password"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>

          <div>
            <label
              className="mb-1 block text-sm font-medium text-black dark:text-white"
              htmlFor="new-password-input"
            >
              New password
            </label>
            <Input
              id="new-password-input"
              type="password"
              autoComplete="new-password"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p className="mt-1 text-xs text-text-secondary">
              At least {MIN_LENGTH} characters.
            </p>
          </div>

          <div>
            <label
              className="mb-1 block text-sm font-medium text-black dark:text-white"
              htmlFor="confirm-password-input"
            >
              Confirm new password
            </label>
            <Input
              id="confirm-password-input"
              type="password"
              autoComplete="new-password"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSubmit();
                }
              }}
            />
          </div>

          {/* Only nag once the user has started filling things in. */}
          {localError && (current || next || confirm) && (
            <p className="text-sm text-amber-600">{localError}</p>
          )}

          <Button
            variant="submit"
            className="mt-2 w-full"
            onClick={handleSubmit}
            disabled={!!localError || isSaving}
          >
            {isSaving ? (
              <Spinner className="icon-sm m-auto" />
            ) : (
              <>
                <KeyRound className="size-4" aria-hidden="true" />
                <span className="ml-2">Update password</span>
              </>
            )}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
};

export default ChangePassword;