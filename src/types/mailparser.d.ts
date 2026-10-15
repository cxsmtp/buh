// The parts of mailparser the chat's mailbox reader uses (the package ships no types).
declare module 'mailparser' {
  interface AddressObject {
    value: Array<{ address?: string; name?: string }>;
  }
  interface ParsedMail {
    subject?: string;
    from?: AddressObject;
    text?: string;
    messageId?: string;
    headers: Map<string, unknown>;
  }
  export function simpleParser(source: Buffer | string, options?: Record<string, unknown>): Promise<ParsedMail>;
}
