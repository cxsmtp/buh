/**
 * Just enough of an IMAP server (over TLS) for test/chat-mailbox.test.mts:
 * one INBOX, LOGIN, SELECT, UID SEARCH UNSEEN, UID FETCH BODY[], UID STORE +FLAGS.
 * Logs every command so tests can check what the shop did.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export interface FakeMessage {
  uid: number;
  raw: string;
  seen?: boolean;
}

export async function startFakeImap(user: string, pass: string, messages: FakeMessage[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-imap-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const log: string[] = [];
  const server = tls.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (socket) => {
    let buf = '';
    let authed = false;
    const send = (s: string) => socket.write(s.endsWith('\r\n') ? s : `${s}\r\n`);
    send('* OK [CAPABILITY IMAP4rev1] fake ready');
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handle(line);
      }
    });
    socket.on('error', () => {});
    const handle = (line: string) => {
      const m = line.match(/^(\S+) (\S+)(?: (.*))?$/);
      if (!m) return;
      const [, tag, cmdRaw, rest = ''] = m;
      const cmd = cmdRaw.toUpperCase();
      log.push(cmd === 'LOGIN' ? 'LOGIN ***' : `${cmd} ${rest}`.trim());
      switch (cmd) {
        case 'CAPABILITY':
          send('* CAPABILITY IMAP4rev1 UIDPLUS');
          return send(`${tag} OK done`);
        case 'LOGIN': {
          const [u, p] = rest.split(' ').map((x) => x.replace(/^"|"$/g, ''));
          if (u === user && p === pass) {
            authed = true;
            return send(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] logged in`);
          }
          return send(`${tag} NO [AUTHENTICATIONFAILED] bad`);
        }
        case 'NOOP':
          return send(`${tag} OK`);
        case 'LOGOUT':
          send('* BYE');
          send(`${tag} OK`);
          return socket.end();
      }
      if (!authed) return send(`${tag} NO not logged in`);
      switch (cmd) {
        case 'LIST':
          send('* LIST (\\HasNoChildren) "/" INBOX');
          return send(`${tag} OK`);
        case 'NAMESPACE':
          send('* NAMESPACE (("" "/")) NIL NIL');
          return send(`${tag} OK`);
        case 'SELECT':
        case 'EXAMINE':
          send(`* ${messages.length} EXISTS`);
          send('* 0 RECENT');
          send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
          send('* OK [UIDVALIDITY 1] ok');
          send(`* OK [UIDNEXT ${messages.length + 1}] ok`);
          return send(`${tag} OK [READ-WRITE] selected`);
        case 'UID': {
          const sub = rest.split(' ')[0].toUpperCase();
          const args = rest.slice(sub.length + 1);
          if (sub === 'SEARCH') {
            const uids = messages.filter((x) => !x.seen && (!/SUBJECT/i.test(args) || x.raw.includes('[Chat #'))).map((x) => x.uid);
            send(`* SEARCH ${uids.join(' ')}`.trim());
            return send(`${tag} OK`);
          }
          if (sub === 'FETCH') {
            const uid = Number(args.split(' ')[0]);
            const msg = messages.find((x) => x.uid === uid);
            if (msg) {
              const body = Buffer.from(msg.raw.replace(/\r?\n/g, '\r\n'));
              socket.write(`* ${messages.indexOf(msg) + 1} FETCH (UID ${uid} BODY[] {${body.length}}\r\n`);
              socket.write(body);
              socket.write(')\r\n');
            }
            return send(`${tag} OK`);
          }
          if (sub === 'STORE') {
            const uid = Number(args.split(' ')[0]);
            const msg = messages.find((x) => x.uid === uid);
            if (msg && /\\Seen/.test(args)) msg.seen = true;
            if (msg) send(`* ${messages.indexOf(msg) + 1} FETCH (UID ${uid} FLAGS (\\Seen))`);
            return send(`${tag} OK`);
          }
          return send(`${tag} BAD unsupported`);
        }
        case 'CLOSE':
        case 'UNSELECT':
          return send(`${tag} OK`);
        default:
          return send(`${tag} BAD unsupported ${cmd}`);
      }
    };
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, log, messages, close: () => server.close() };
}
