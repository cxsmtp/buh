'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, CheckCheck, Loader2, Mail, MessageCircle, MessagesSquare, RefreshCw, Send, User } from 'lucide-react';
import type { ChatMessage, ChatThread } from '@/types';
import { getJson, postJson, safeHref, sendJson } from '@/lib/apiClient';

/**
 * Admin Hub → Chats. Conversations from the shop's chat: the ones waiting for a
 * person first. Reply here (or by replying to the email); the customer sees it
 * in their chat within seconds, or by email if they left. On a phone the list
 * and the conversation take turns; on a computer they sit side by side.
 */

interface MailboxStatus {
  configured: boolean;
  last: { at: string; ok: boolean; error?: string } | null;
}

const STATUS: Record<ChatThread['status'], { label: string; cls: string }> = {
  waiting: { label: 'Waiting for you', cls: 'bg-red-100 text-red-800' },
  human: { label: 'You replied', cls: 'bg-emerald-100 text-emerald-800' },
  bot: { label: 'Assistant', cls: 'bg-stone-100 text-stone-600' },
  closed: { label: 'Closed', cls: 'bg-stone-100 text-stone-400' },
};

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AdminChatsTab({ refreshKey }: { refreshKey: number }) {
  const [chats, setChats] = useState<ChatThread[] | null>(null);
  const [mailbox, setMailbox] = useState<MailboxStatus | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void getJson<{ chats: ChatThread[]; mailbox: MailboxStatus; message?: string }>(`/api/admin/chats?filter=${filter}`).then(({ ok, data }) => {
      if (ok) {
        setChats(data.chats);
        setMailbox(data.mailbox);
      } else setError(data.message || 'Could not load the chats.');
    });
  }, [filter, refreshKey]);

  const waiting = (chats ?? []).filter((c) => c.status === 'waiting');
  const rest = (chats ?? []).filter((c) => c.status !== 'waiting');
  const open = chats?.find((c) => c.id === openId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-serif font-bold text-lg text-[#0f1c2e] flex items-center gap-2">
          <MessagesSquare className="w-5 h-5 text-[#c5a059]" /> Chats
        </h2>
        <div className="ml-auto flex gap-1.5 text-xs">
          {(['open', 'all'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`px-2.5 py-1 rounded-full border font-semibold ${filter === f ? 'bg-[#0f1c2e] text-white border-[#0f1c2e]' : 'bg-white border-stone-300 text-stone-700'}`}>
              {f === 'open' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>
      <MailboxNote mailbox={mailbox} onChecked={setMailbox} />
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3">
        <div className={`${openId ? 'hidden lg:block' : ''} space-y-2`}>
          {chats === null && <p className="text-xs text-stone-500">Loading…</p>}
          {chats?.length === 0 && (
            <p className="text-center text-sm text-stone-500 py-10 bg-white rounded-2xl border border-stone-200">No chats yet. When a customer asks for a person, it shows here and you get an email.</p>
          )}
          {[...waiting, ...rest].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpenId(c.id)}
              className={`w-full text-left bg-white rounded-2xl border p-3 space-y-1 ${openId === c.id ? 'border-[#c5a059] ring-1 ring-[#c5a059]' : 'border-stone-200'} hover:border-stone-400`}
            >
              <div className="flex items-center gap-2 text-xs">
                <strong className="text-[#0f1c2e] truncate">{c.customerName || c.contact || 'Customer'}</strong>
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                {c.unread > 0 && <span className="ml-auto w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{c.unread}</span>}
              </div>
              <p className="text-xs text-stone-600 line-clamp-2">{c.lastMessage}</p>
              <p className="text-[10px] text-stone-400">{time(c.updatedAt)}{c.contact && c.customerName ? ` · ${c.contact}` : ''}</p>
            </button>
          ))}
        </div>

        <div className={openId ? '' : 'hidden lg:block'}>
          {open ? (
            <Conversation key={open.id} thread={open} refreshKey={refreshKey} onBack={() => setOpenId(null)} onChanged={(t) => setChats((list) => (list ?? []).map((x) => (x.id === t.id ? { ...x, ...t } : x)))} />
          ) : (
            <div className="hidden lg:flex h-full min-h-60 items-center justify-center text-sm text-stone-400 bg-white rounded-2xl border border-dashed border-stone-300">Choose a chat</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MailboxNote({ mailbox, onChecked }: { mailbox: MailboxStatus | null; onChecked: (m: MailboxStatus) => void }) {
  const [busy, setBusy] = useState(false);
  if (!mailbox) return null;
  if (!mailbox.configured) {
    return <p className="text-[11px] text-stone-500">Replying by email is off: set up the mailbox in Settings → Email & admin account. You can always reply here.</p>;
  }
  const check = async () => {
    setBusy(true);
    const { ok, data } = await postJson<{ mailbox: MailboxStatus }>('/api/admin/chats/check-mail', {});
    setBusy(false);
    if (ok) onChecked(data.mailbox);
  };
  return (
    <p className="text-[11px] text-stone-500 flex flex-wrap items-center gap-2">
      <Mail className="w-3.5 h-3.5" />
      {mailbox.last ? (mailbox.last.ok ? `Emailed replies checked ${time(mailbox.last.at)}.` : `The mailbox could not be read (${mailbox.last.error}).`) : 'Emailed replies are checked every minute.'}
      <button type="button" onClick={() => void check()} disabled={busy} className="inline-flex items-center gap-1 underline disabled:opacity-50">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Check now
      </button>
    </p>
  );
}

function Conversation({ thread, refreshKey, onBack, onChanged }: { thread: ChatThread; refreshKey: number; onBack: () => void; onChanged: (t: Partial<ChatThread> & { id: string }) => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getJson<{ messages: ChatMessage[]; thread: ChatThread }>(`/api/admin/chats/${encodeURIComponent(thread.id)}`).then(({ ok, data }) => {
      if (!ok) return;
      setMessages(data.messages);
      onChanged({ id: thread.id, unread: 0, status: data.thread.status });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, refreshKey]);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError('');
    const { ok, data } = await postJson<{ message?: ChatMessage | string }>(`/api/admin/chats/${encodeURIComponent(thread.id)}`, { message: draft });
    setBusy(false);
    if (!ok || typeof data.message !== 'object') {
      setError((typeof data.message === 'string' && data.message) || 'Could not send.');
      return;
    }
    const sent = data.message;
    setDraft('');
    setMessages((m) => [...(m ?? []), sent]);
    onChanged({ id: thread.id, status: 'human', lastMessage: sent.body });
  };

  const setStatus = async (status: 'closed' | 'bot') => {
    const { ok, data } = await sendJson<{ thread?: ChatThread }>('PATCH', `/api/admin/chats/${encodeURIComponent(thread.id)}`, { status });
    if (ok && data.thread) onChanged(data.thread);
  };

  const phone = thread.contact.startsWith('+') ? thread.contact.replace(/\D/g, '') : '';
  const wa = phone ? safeHref(`https://wa.me/${phone}?text=${encodeURIComponent(`Hello${thread.customerName ? ` ${thread.customerName.split(' ')[0]}` : ''}, this is Beautiful UAE Home replying to your chat on our website.`)}`) : undefined;

  return (
    <div className="bg-white rounded-2xl border border-stone-200 flex flex-col max-h-[75vh] min-h-[50vh]">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-stone-100 text-xs">
        <button type="button" onClick={onBack} className="lg:hidden p-1.5 -ml-1 rounded-lg border border-stone-200" aria-label="Back to the list">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="font-bold text-[#0f1c2e] truncate">{thread.customerName || 'Customer'}</div>
          <div className="text-stone-500 truncate">{thread.contact || 'No contact details yet'}{thread.page ? ` · on ${thread.page}` : ''}</div>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {wa && (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="px-2 py-1 rounded-lg border border-emerald-300 text-emerald-700 font-semibold inline-flex items-center gap-1">
              <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
            </a>
          )}
          {thread.contact.includes('@') && (
            <a href={`mailto:${thread.contact}`} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1">
              <Mail className="w-3.5 h-3.5" /> Email
            </a>
          )}
          {thread.status !== 'closed' ? (
            <button type="button" onClick={() => void setStatus('closed')} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1">
              <CheckCheck className="w-3.5 h-3.5" /> Close
            </button>
          ) : (
            <button type="button" onClick={() => void setStatus('bot')} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold">Reopen</button>
          )}
          {thread.status !== 'bot' && thread.status !== 'closed' && (
            <button type="button" onClick={() => void setStatus('bot')} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1" title="The assistant answers new questions again">
              <Bot className="w-3.5 h-3.5" /> Back to assistant
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm" aria-live="polite">
        {messages === null && <p className="text-xs text-stone-500">Loading…</p>}
        {(messages ?? []).map((m) => (
          <div key={m.id} className={`flex ${m.author === 'admin' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 whitespace-pre-wrap break-words ${
                m.author === 'admin' ? 'bg-[#0f1c2e] text-white' : m.author === 'customer' ? 'bg-amber-50 border border-amber-200 text-stone-800' : 'bg-stone-100 text-stone-600 text-xs'
              }`}
            >
              <div className="text-[10px] opacity-70 mb-0.5 flex items-center gap-1">
                {m.author === 'customer' ? <User className="w-3 h-3" /> : m.author === 'bot' ? <Bot className="w-3 h-3" /> : null}
                {m.author === 'customer' ? 'Customer' : m.author === 'bot' ? 'Assistant' : m.author === 'admin' ? 'You' : 'Shop'} · {time(m.at)}
                {m.via === 'email' && ' · by email'}
              </div>
              {m.body}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => void send(e)} className="p-3 border-t border-stone-100 flex gap-2 items-end">
        <label className="sr-only" htmlFor="admin-chat-reply">Your reply</label>
        <textarea
          id="admin-chat-reply"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
          }}
          rows={2}
          maxLength={4000}
          placeholder="Type your reply…"
          className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059] resize-y"
        />
        <button type="submit" disabled={busy || !draft.trim()} className="px-3.5 py-2.5 rounded-xl bg-[#0f1c2e] text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send
        </button>
      </form>
      {error && <p role="alert" className="px-3 pb-3 text-xs text-red-700">{error}</p>}
    </div>
  );
}
