'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, MessageCircle, MessagesSquare, RotateCcw, Send, UserRound, X } from 'lucide-react';
import type { ChatMessage } from '@/types';
import { getJson, postJson } from '@/lib/apiClient';
import { OPEN_CHAT_EVENT, askWhatsAppLink, instagramLink, useShop } from '@/lib/client/shop';
import { InstagramIcon } from '@/components/common/InstagramIcon';

/**
 * The floating help button. With the chat switched on it opens the shop
 * assistant (it answers sizes, delivery, payment, care and discount questions
 * from Settings → Chat assistant, and hands over to a person otherwise), with
 * WhatsApp and Instagram underneath if they are switched on. With the chat off
 * and only WhatsApp on, it is the WhatsApp button it always was.
 *
 * The conversation survives a reload (its id and secret are kept in this browser).
 */

interface View {
  id: string;
  status: 'bot' | 'waiting' | 'human' | 'closed';
  needsContact: boolean;
  contact: string;
  messages: ChatMessage[];
  token?: string;
  message?: string;
}

const KEY = 'buh_chat_v1';
const SUGGESTIONS = ['Sizes & measurements', 'How long is delivery?', 'Any discount?', 'How do I wash it?'];

function loadSaved(): { id: string; token: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v.id === 'string' && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function HelpLauncher() {
  const { store, chat } = useShop();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [contact, setContact] = useState({ name: '', contact: '' });
  const [unseen, setUnseen] = useState(false);
  const saved = useRef<{ id: string; token: string } | null>(null);
  const lastId = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const wa = askWhatsAppLink(store, store.whatsappGreeting);
  const ig = instagramLink(store);
  const floatingWa = store.showWhatsAppButton ? wa : null;

  const merge = useCallback((next: View) => {
    setView((v) => {
      const known = new Set((v?.messages ?? []).map((m) => m.id));
      const all = [...(v?.messages ?? []), ...next.messages.filter((m) => !known.has(m.id))].sort((a, b) => a.id - b.id);
      lastId.current = all.length ? all[all.length - 1].id : lastId.current;
      return { ...next, messages: all };
    });
  }, []);

  const poll = useCallback(async () => {
    const s = saved.current;
    if (!s) return;
    const res = await fetch(`/api/chat/${encodeURIComponent(s.id)}?after=${lastId.current}`, { headers: { 'x-chat-token': s.token }, credentials: 'same-origin' }).catch(() => null);
    if (!res) return;
    if (res.status === 404) {
      saved.current = null;
      try {
        localStorage.removeItem(KEY);
      } catch {
        // not essential
      }
      setView(null);
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as View;
    if (data.messages.some((m) => m.author === 'admin')) setUnseen(true);
    merge(data);
  }, [merge]);

  // A conversation from before the reload.
  useEffect(() => {
    const s = loadSaved();
    if (!s) return;
    saved.current = s;
    void poll();
  }, [poll]);

  // While open: new messages every 4 s. Closed, but a person is on it: every 30 s (for the dot).
  useEffect(() => {
    if (!view) return;
    const waitingForPerson = view.status === 'waiting' || view.status === 'human';
    if (!open && !waitingForPerson) return;
    const t = setInterval(() => void poll(), open ? 4000 : 30_000);
    return () => clearInterval(t);
  }, [open, view, poll]);

  // Keyboard: focus the message box when the chat opens, and the Help button again when it closes.
  useEffect(() => {
    if (open) input.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'nearest' });
  }, [open, view?.messages.length, view?.needsContact]);

  // "Ask in chat" on a product opens this with the product named.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text ?? '';
      setOpen(true);
      setUnseen(false);
      if (text) setDraft(text);
      setTimeout(() => input.current?.focus(), 50);
    };
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!chat) {
    // The chat is off: the plain WhatsApp button, as before.
    if (!floatingWa) return null;
    return (
      <a href={floatingWa} target="_blank" rel="noopener noreferrer" aria-label="Chat with us on WhatsApp" className="fixed z-40 right-3 bottom-20 md:bottom-6 md:right-6 w-12 h-12 rounded-full bg-[#1f9d55] text-white shadow-lg flex items-center justify-center hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300">
        <MessageCircle className="w-6 h-6" />
      </a>
    );
  }

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    const s = saved.current;
    const res = s
      ? await postJson<View>(`/api/chat/${encodeURIComponent(s.id)}`, { token: s.token, after: lastId.current, ...body })
      : await postJson<View>('/api/chat', { message: body.message, page: window.location.pathname });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 404 && s) {
        // That chat is gone: start a new one with this message.
        saved.current = null;
        setView(null);
        if (body.action === 'send') return call({ message: body.message });
      }
      setError(res.data.message || 'Could not send. Please try again.');
      return false;
    }
    if (!s && res.data.token) {
      saved.current = { id: res.data.id, token: res.data.token };
      try {
        localStorage.setItem(KEY, JSON.stringify(saved.current));
      } catch {
        // private mode: the chat lasts for this page
      }
    }
    merge(res.data);
    return true;
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    if (await call({ action: 'send', message: t })) setDraft('');
  };

  const startOver = () => {
    saved.current = null;
    lastId.current = 0;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // not essential
    }
    setView(null);
  };

  const shown = view?.messages ?? [];
  const greeting = chat.greeting;

  return (
    <>
      {!open && (
        <button
          ref={launcher}
          type="button"
          onClick={() => {
            setOpen(true);
            setUnseen(false);
          }}
          aria-label="Help and chat"
          className="fixed z-40 right-3 bottom-20 md:bottom-6 md:right-6 h-12 pl-3.5 pr-4 rounded-full bg-[#0f1c2e] text-white shadow-lg flex items-center gap-2 hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-300"
        >
          <MessagesSquare className="w-5 h-5 text-amber-300" />
          <span className="text-xs font-bold">Help</span>
          {unseen && <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-red-500" aria-label="New reply" />}
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="Chat with the shop"
          className="fixed z-50 inset-x-2 bottom-2 top-16 sm:inset-auto sm:right-6 sm:bottom-6 sm:w-[380px] sm:h-[600px] sm:max-h-[calc(100vh-3rem)] bg-white rounded-3xl shadow-2xl border border-stone-200 flex flex-col overflow-hidden"
        >
          <header className="flex items-center gap-2 px-4 py-3 bg-[#0f1c2e] text-white">
            <Bot className="w-5 h-5 text-amber-300" />
            <div className="min-w-0">
              <div className="text-sm font-bold truncate">{chat.name}</div>
              <div className="text-[10px] opacity-75">
                {view?.status === 'waiting' ? 'Asking the team…' : view?.status === 'human' ? 'The team is here' : 'Replies instantly · a person when you need one'}
              </div>
            </div>
            {view && (
              <button type="button" onClick={startOver} className="ml-auto p-1.5 rounded-lg hover:bg-white/10" aria-label="Start a new chat" title="Start a new chat">
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className={`${view ? '' : 'ml-auto'} p-1.5 rounded-lg hover:bg-white/10`} aria-label="Close chat">
              <X className="w-5 h-5" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 text-sm bg-stone-50" aria-live="polite">
            {!view && greeting && <Bubble author="bot" body={greeting} />}
            {shown.map((m) => (
              <Bubble key={m.id} author={m.author} body={m.body} />
            ))}
            {view?.needsContact && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void call({ action: 'contact', name: contact.name, contact: contact.contact });
                }}
                className="bg-white border border-amber-200 rounded-2xl p-3 space-y-2 text-xs"
              >
                <p className="font-semibold text-stone-800">So we can get back to you:</p>
                <label className="block">
                  <span className="text-stone-600">Your name</span>
                  <input value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} maxLength={80} autoComplete="name" className="mt-0.5 w-full px-3 py-2 rounded-xl border border-stone-300 text-sm" />
                </label>
                <label className="block">
                  <span className="text-stone-600">Phone (WhatsApp) or email</span>
                  <input value={contact.contact} onChange={(e) => setContact((c) => ({ ...c, contact: e.target.value }))} required maxLength={254} placeholder="050 123 4567 or you@example.com" className="mt-0.5 w-full px-3 py-2 rounded-xl border border-stone-300 text-sm" />
                </label>
                <button type="submit" disabled={busy} className="w-full py-2 rounded-xl bg-[#0f1c2e] text-white font-bold disabled:opacity-50">Save my details</button>
              </form>
            )}
            {busy && (
              <div className="flex items-center gap-1.5 text-xs text-stone-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> …
              </div>
            )}
            <div ref={end} />
          </div>

          {(!view || view.status === 'bot') && (
            <div className="px-3 pt-2 flex gap-1.5 overflow-x-auto no-scrollbar bg-white border-t border-stone-100">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => void send(s)} className="shrink-0 px-2.5 py-1.5 rounded-full border border-stone-300 text-[11px] font-semibold text-stone-700 bg-white hover:bg-stone-50">
                  {s}
                </button>
              ))}
              {view && (
                <button type="button" disabled={busy} onClick={() => void call({ action: 'person' })} className="shrink-0 px-2.5 py-1.5 rounded-full border border-amber-300 text-[11px] font-semibold text-amber-800 bg-amber-50 inline-flex items-center gap-1">
                  <UserRound className="w-3 h-3" /> Talk to a person
                </button>
              )}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            className="p-3 bg-white flex items-end gap-2"
          >
            <label htmlFor="chat-input" className="sr-only">Your message</label>
            <textarea
              id="chat-input"
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={1}
              maxLength={1000}
              placeholder="Type your question…"
              className="flex-1 min-w-0 resize-none px-3 py-2.5 rounded-2xl border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
            />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send" className="w-10 h-10 rounded-full bg-[#0f1c2e] text-white flex items-center justify-center disabled:opacity-40">
              <Send className="w-4 h-4" />
            </button>
          </form>
          {error && <p role="alert" className="px-3 pb-2 text-xs text-red-700 bg-white">{error}</p>}

          {(wa || ig) && (
            <div className="px-3 pb-3 bg-white flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
              <span>Or message us on</span>
              {wa && (
                <a href={wa} target="_blank" rel="noopener noreferrer" aria-label="Chat with us on WhatsApp" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold">
                  <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                </a>
              )}
              {ig && (
                <a href={ig} target="_blank" rel="noopener noreferrer" aria-label="Message us on Instagram" className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-pink-50 text-pink-800 border border-pink-200 font-semibold">
                  <InstagramIcon className="w-3.5 h-3.5" /> Instagram
                </a>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Bubble({ author, body }: { author: ChatMessage['author']; body: string }) {
  if (author === 'system') {
    return <p className="text-center text-[11px] text-stone-500 px-4 py-1 whitespace-pre-wrap">{body}</p>;
  }
  const mine = author === 'customer';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 whitespace-pre-wrap break-words ${mine ? 'bg-[#0f1c2e] text-white rounded-br-md' : author === 'admin' ? 'bg-amber-50 border border-amber-200 text-stone-800 rounded-bl-md' : 'bg-white border border-stone-200 text-stone-800 rounded-bl-md'}`}>
        {author === 'admin' && <div className="text-[10px] font-bold text-amber-800 mb-0.5">The team</div>}
        {body}
      </div>
    </div>
  );
}
