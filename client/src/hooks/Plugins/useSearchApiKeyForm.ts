import { useRef, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import useAuthSearchTool from '~/hooks/Plugins/useAuthSearchTool';
import type { SearchApiKeyFormData } from '~/hooks/Plugins/useAuthSearchTool';
import { useToastContext } from '@librechat/client';
export default function useSearchApiKeyForm({
  onSubmit,
  onRevoke,
}: {
  onSubmit?: () => void;
  onRevoke?: () => void;
}) {
  const methods = useForm<SearchApiKeyFormData>();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const badgeTriggerRef = useRef<HTMLInputElement>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { installTool, removeTool } = useAuthSearchTool({ isEntityTool: true });
  const { reset } = methods;
  const { showToast } = useToastContext();
  const onSubmitHandler = useCallback(
    (data: SearchApiKeyFormData) => {
      installTool(data, {
        onSuccess: () => {
          setIsDialogOpen(false);
          onSubmit?.();
        },
        onError: (error: any) => {
          // Keep the dialog OPEN and clear the field — otherwise a rejected key
          // looks saved (the input retains what was typed).
          reset();
          const message =
            error?.response?.data?.message ??
            'That API key was rejected. Check you copied it correctly and try again.';
          showToast({ message, status: 'error' });
        },
      });
    },
    [onSubmit, installTool, reset, showToast],
  );

  const handleRevokeApiKey = useCallback(() => {
    reset();
    removeTool();
    setIsDialogOpen(false);
    onRevoke?.();
  }, [reset, onRevoke, removeTool]);

  return {
    methods,
    isDialogOpen,
    setIsDialogOpen,
    handleRevokeApiKey,
    onSubmit: onSubmitHandler,
    badgeTriggerRef,
    menuTriggerRef,
  };
}
