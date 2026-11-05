import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export type ReportContact = Readonly<{ name: string; company?: string; email?: string; phone?: string; website?: string }>;

/** PDF publication must never silently lose its publisher's reply details. */
export async function resolveReportContact(explicitPath: string | undefined, defaultPath: string): Promise<ReportContact> {
  let contact: ReportContact;
  try { contact = await readReportContactFile(explicitPath ?? defaultPath); }
  catch (error) {
    if (!explicitPath && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('pdf_report_contact_required: configure private .report-contact.json or pass --report-contact-file');
    throw error;
  }
  if (!contact.email && !contact.phone) throw new Error('pdf_report_contact_reply_channel_required');
  return contact;
}
export function validateReportContact(value: unknown): ReportContact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_report_contact');
  const item = value as Record<string, unknown>;
  const limits: Record<string, number> = { name: 100, company: 100, email: 254, phone: 40, website: 200 };
  if (Object.keys(item).some(key => !Object.hasOwn(limits, key))) throw new Error('invalid_report_contact');
  for (const [key, limit] of Object.entries(limits)) if (item[key] !== undefined && (typeof item[key] !== 'string' || (item[key] as string).length > limit || /[\u0000-\u001f\u007f]/u.test(item[key] as string))) throw new Error('invalid_report_contact');
  if (typeof item.name !== 'string' || ![item.name, item.company].some(s => typeof s === 'string' && /\p{L}{2}/u.test(s.trim()))) throw new Error('report_contact_identity_required');
  const contact = Object.fromEntries(Object.entries(item).map(([key, v]) => [key, (v as string).trim()])) as ReportContact;
  if (contact.email !== undefined && !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/u.test(contact.email)) throw new Error('invalid_report_contact_email');
  if (contact.email && (contact.email.includes('..') || contact.email.startsWith('.') || contact.email.includes('.@') || contact.email.split('@')[1]!.split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)))) throw new Error('invalid_report_contact_email');
  if (contact.phone !== undefined && (!/^\+?[\d ()/.-]+$/u.test(contact.phone) || contact.phone.replace(/\D/gu, '').length < 7 || contact.phone.replace(/\D/gu, '').length > 15)) throw new Error('invalid_report_contact_phone');
  if (contact.website !== undefined) {
    let url: URL; try { url = new URL(contact.website); } catch { throw new Error('invalid_report_contact_website'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_report_contact_website');
  }
  if (!contact.email && !contact.phone && !contact.website) throw new Error('report_contact_reply_channel_required');
  return contact;
}

/** Read at most 8 KiB; never include input values in errors or audit state. */
export async function readReportContactFile(path: string): Promise<ReportContact> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_report_contact_file');
    const bytes = Buffer.alloc(8193);
    let size = 0;
    while (size < bytes.length) { const r = await file.read(bytes, size, bytes.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    if (size > 8192) throw new Error('report_contact_file_too_large');
    let value: unknown; try { value = JSON.parse(bytes.subarray(0, size).toString('utf8')); } catch { throw new Error('invalid_report_contact_json'); }
    return validateReportContact(value);
  } finally { await file.close(); }
}
