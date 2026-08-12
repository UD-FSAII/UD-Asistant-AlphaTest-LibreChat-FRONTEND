import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthType, Tools, QueryKeys } from 'librechat-data-provider';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';

export type SearchApiKeyFormData = {
  // Selected options
  selectedProvider: string;
  selectedReranker: string;
  selectedScraper: string;
  // API keys and URLs
  serperApiKey: string;
  searxngInstanceUrl: string;
  searxngApiKey: string;
  firecrawlApiKey: string;
  firecrawlApiUrl: string;
  tavilyApiKey: string;
  jinaApiKey: string;
  jinaApiUrl: string;
  cohereApiKey: string;
};

const useAuthSearchTool = (options?: { isEntityTool: boolean }) => {
  const queryClient = useQueryClient();
  const isEntityTool = options?.isEntityTool ?? true;
  const updateUserPlugins = useUpdateUserPluginsMutation({
    onMutate: (vars) => {
      queryClient.setQueryData([QueryKeys.toolAuth, Tools.web_search], () => {
        return {
          authenticated: vars.action === 'install',
          authTypes:
            vars.action === 'install'
              ? [
                  ['providers', AuthType.USER_PROVIDED],
                  ['scrapers', AuthType.USER_PROVIDED],
                  ['rerankers', AuthType.USER_PROVIDED],
                ]
              : [],
        };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.toolAuth, Tools.web_search]);
    },
    onError: () => {
      queryClient.invalidateQueries([QueryKeys.toolAuth, Tools.web_search]);
    },
  });

  const installTool = useCallback(
    (
      data: SearchApiKeyFormData,
      callbacks?: { onSuccess?: () => void; onError?: (error: unknown) => void },
    ) => {
      const auth = Object.entries({
        serperApiKey: data.serperApiKey,
        searxngInstanceUrl: data.searxngInstanceUrl,
        searxngApiKey: data.searxngApiKey,
        firecrawlApiKey: data.firecrawlApiKey,
        firecrawlApiUrl: data.firecrawlApiUrl,
        tavilyApiKey: data.tavilyApiKey,
        jinaApiKey: data.jinaApiKey,
        jinaApiUrl: data.jinaApiUrl,
        cohereApiKey: data.cohereApiKey,
      }).reduce(
        (acc, [key, value]) => {
          if (value) {
            acc[key] = value;
          }
          return acc;
        },
        {} as Record<string, string>,
      );
/**
       * UD Assistant: forward per-call callbacks so the dialog can react to a
       * rejected key. The server validates a user-supplied Brave key against
       * Brave's API and returns 400 if it fails (see UserController
       * `verifyBraveKey`) — without these the dialog closed regardless and the
       * user believed a bad key had saved.
       */
      updateUserPlugins.mutate(
        {
          pluginKey: Tools.web_search,
          action: 'install',
          auth,
          isEntityTool,
        },
        {
          onSuccess: () => callbacks?.onSuccess?.(),
          onError: (error) => callbacks?.onError?.(error),
        },
      );
    },
    [updateUserPlugins, isEntityTool],
  );


  const removeTool = useCallback(() => {
    updateUserPlugins.mutate({
      pluginKey: Tools.web_search,
      action: 'uninstall',
      auth: {},
      isEntityTool,
    });
  }, [updateUserPlugins, isEntityTool]);

  return {
    removeTool,
    installTool,
  };
};

export default useAuthSearchTool;
