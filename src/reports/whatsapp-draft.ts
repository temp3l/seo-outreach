import { customerPriorityObservation, customerPriorityProjection } from './customer.js';
import type { AuditResult } from '@spora/webcrawl';
import { portugueseOpportunities } from './customer-pt.js';
import { validateReportContact, type ReportContact } from './report-contact.js';
import { isReportableEvidenceAdmissible, type CustomerReleaseQualification } from './qualification.js';
import { reportPageReference } from './references.js';

function markdownValue(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[|<>`]/gu, '');
}

/** Create a plain-text outreach draft from evidence captured in this audit. */
export function renderWhatsAppDraft(result: AuditResult, reportAttachment?: string, publicationStatus: 'CLIENT_READY' | 'HOLD' = 'HOLD', qualification?: CustomerReleaseQualification): string {
  // A caller-supplied status and qualification do not establish a reviewed PDF.
  const reportStatus = 'HOLD';
  const shareUrl = (raw: string): string | undefined => reportPageReference(raw)?.url;
  const website = markdownValue(shareUrl(result.target) ?? new URL(result.target).origin);
  const host = (() => { try { return new URL(result.target).hostname; } catch { return result.target; } })();
  const projection = customerPriorityProjection(result);
  const topic = projection.selected[0];
  const ref = topic?.urls[0];
  const observation = topic && customerPriorityObservation(projection.customerFindings, topic);
  const finding = observation?.finding, evidence = observation?.evidence;
  let sentence: string | undefined = topic?.observed || 'a captured page was flagged for review.';
  if (finding?.code === 'broken_internal_link') {
    const source = evidence;
    sentence = undefined;
    if (source?.anchorHref) {
      try {
        const destination = reportPageReference(new URL(source.anchorHref, source.pageUrl).href);
        const from = reportPageReference(source.pageUrl);
        if (destination && from && typeof source.value === 'number') {
          const referringPage = from.redacted ? 'a captured referring page (exact address withheld for query privacy)' : from.url;
          sentence = destination.redacted
            ? `a link on ${referringPage} returned HTTP ${source.value}; its exact destination is withheld for query privacy.`
            : `${from.redacted ? referringPage : `the page ${referringPage}`} linked to ${destination.url}, which returned HTTP ${source.value}`;
        }
      } catch { /* Invalid evidence abstains. */ }
    }
  } else if (finding?.code === 'missing_meta_description') sentence = 'no meta description was recorded on this captured page';
  const candidate = topic && ref && evidence && sentence ? { sentence: `${sentence} ${topic.why} ${topic.action}`, url: ref.redacted ? 'exact example address withheld for query privacy' : ref.url, observedAt: evidence.observedAt } : undefined;
  // Site evidence establishes formatting/channel observations, never ownership.
  // Keep candidates in the private audit; do not promote one to a send target.
  const contactLine = '- **recipient_review_required:** true\n- **selected_send_target:** null\n- **Recipient decision:** HOLD — verify business ownership, company context and WhatsApp channel in the private contact inventory before selecting a recipient.\n';
  const attachmentLine = reportAttachment ? `- **Report artifact:** \`${markdownValue(reportAttachment)}\` (HOLD preview; do not attach to customer message)\n` : '';
  return `# ${markdownValue(host)} — WhatsApp outreach draft

- **Website:** ${website}
- **Report release:** ${reportStatus}
- **Outbound approval:** false — recipient ownership, permitted channel, opt-out/suppression and final human send approval remain unverified
${contactLine}${attachmentLine}

\`\`\`text
${candidate ? `Hello!\n\nDuring an archived crawl of ${host}, ${candidate.sentence} (${candidate.url}; recorded ${candidate.observedAt}). This is an observation from that crawl, not a check of the current site. Would you like me to share this observation for review?` : 'REVIEW_REQUIRED — no suitably specific, traceable customer observation was selected. Keep this as an internal draft.'}

\`\`\`
`;
}

/** Draft only: an observed opportunity never authorizes a recipient or a send. */
export function renderPortugueseWhatsAppDraft(result: AuditResult, issuer: ReportContact): string | null {
  const topic = portugueseOpportunities(result).find(candidate => {
    const finding = result.findings.find(item => item.code === candidate.code && item.evidence.some(evidence => evidence.pageUrl === candidate.url || evidence.anchorHref && (() => { try { return new URL(evidence.anchorHref, evidence.pageUrl).href === candidate.target; } catch { return false; } })()));
    return !!finding && isReportableEvidenceAdmissible(result, finding);
  });
  if (!topic) return null;
  const sender = validateReportContact(issuer);
  const observation = topic.code === 'noindex'
    ? 'encontrei uma instrução que pede aos buscadores para não indexar uma página'
    : topic.code === 'broken_internal_link'
      ? 'encontrei um link que levou a um endereço indisponível durante a coleta'
      : 'não encontrei uma meta descrição em uma página';
  return `# Rascunho de WhatsApp — revisão pendente

- **recipient_review_required:** true
- **selected_send_target:** null
- **Recipient decision:** HOLD — verificar identidade, permissão e aprovação da mensagem antes de qualquer envio.
- **Report attachment:** none — a qualificação de liberação e a aprovação de envio são decisões separadas.
- **Outbound approval:** false — ownership, canal permitido, supressão/opt-out e aprovação humana ainda precisam ser verificados.

\`\`\`text
Olá! Sou ${markdownValue(sender.name)}. Na análise arquivada do site, ${observation}: ${markdownValue(topic.url)} (observado em ${markdownValue(topic.observedAt)}).

Posso compartilhar essa observação e uma sugestão para análise?
\`\`\`
`;
}
