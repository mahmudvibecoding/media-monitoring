"use client";

import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type RefObject, useCallback } from "react";

import {
  checkMessageMutation,
  labelMessageMutation,
  telegramChannelMessagesInfiniteQueryKey,
} from "@/api/@tanstack/react-query.gen";
import type { TelegramChannelMessagesData, TelegramMessage, TelegramMessages } from "@/api/types.gen";
import { type NameStore, useNameEditing } from "@/components/name-labels";
import { useTelegram } from "@/components/telegram-frame";

// Correcting the names labelled by hand in a chat's messages (see name-labels.tsx), and marking a message whose names
// are right checked, so that what's left to check shows in the chat list, and where to go on from

type Query = TelegramChannelMessagesData["query"];

// The editing of a chat's names, while on: the toolbar, how messages pick (see Bubble), and checking them. column is
// the chat's scroller, whose parent the toolbar is placed in.
export function useLabelEditing({
  id,
  query,
  column,
  on,
}: {
  id: number;
  query: Query;
  column: RefObject<HTMLDivElement | null>;
  on: boolean;
}) {
  const t = useTranslations("telegramChannel");
  const { toast } = useTelegram();
  const queryClient = useQueryClient();
  const save = useMutation(labelMessageMutation());
  const mark = useMutation(checkMessageMutation());
  const key = telegramChannelMessagesInfiniteQueryKey({ path: { channel_id: id }, query });

  const message = (messageId: number) =>
    queryClient
      .getQueryData<InfiniteData<TelegramMessages>>(key)
      ?.pages.flatMap((page) => page.messages)
      .find((m) => m.id === messageId);

  function change(messageId: number, changed: Partial<TelegramMessage>) {
    queryClient.setQueryData<InfiniteData<TelegramMessages>>(key, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m) => (m.id === messageId ? { ...m, ...changed } : m)),
            })),
          }
        : data,
    );
  }

  // The chat's other views (all its messages, a model's) are read again when next shown
  const store: NameStore<number> = {
    find: message,
    show: (messageId, names) => change(messageId, { names }),
    save: (messageId, names, done) =>
      save.mutate(
        {
          path: { channel_id: id, message_id: messageId },
          body: { names: names.map(({ kind, start, end }) => ({ kind, start: start!, end: end! })) },
        },
        {
          onSuccess: (saved) => {
            done.onSuccess(saved);
            void queryClient.invalidateQueries({
              queryKey: [{ _id: "telegramChannelMessages", path: { channel_id: id } }],
              refetchType: "none",
            });
          },
          onError: done.onError,
        },
      ),
    failed: () => toast(t("notSaved")),
  };
  const area = useCallback(() => column.current?.parentElement, [column]);
  const scroller = useCallback(() => column.current, [column]);
  const editing = useNameEditing({ store, area, scroller, on });

  // Marks a message checked, or not any more: at once, then saved; the chat list's counts and the progress are read
  // again
  function check(m: TelegramMessage) {
    const before = m.checked_at ?? null;
    change(m.id, { checked_at: before ? null : new Date().toISOString() });
    mark.mutate(
      { path: { channel_id: id, message_id: m.id }, body: { checked: !before } },
      {
        onSuccess: (saved) => {
          change(m.id, { checked_at: saved.checked_at });
          void queryClient.invalidateQueries({ queryKey: [{ _id: "telegramChannels" }] });
          void queryClient.invalidateQueries({ queryKey: [{ _id: "labelledProgress" }] });
        },
        onError: () => {
          change(m.id, { checked_at: before });
          toast(t("notSaved"));
        },
      },
    );
  }

  return { pick: editing.pick, check: on ? check : undefined, toolbar: editing.toolbar };
}
