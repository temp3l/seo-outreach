/** Compare already identity-validated audits; optional image failures do not erase other evidence. */
export function businessTargetKey(raw) {
  try {const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;return `${u.hostname.toLowerCase().replace(/^www\./u,'')}${u.pathname.replace(/\/+$/u,'')||'/'}${u.search}`;} catch {return null;}
}
export function sameBusinessTarget(site,canonical,summaryTarget,auditTarget,seedFinal) {
  try {
    const host=raw=>new URL(raw).hostname.toLowerCase().replace(/^www\./u,'');
    const path=raw=>{const u=new URL(raw);return `${u.pathname.replace(/\/+$/u,'')||'/'}${u.search}`;};
    return typeof canonical==='string'&&site===summaryTarget&&site===auditTarget&&host(site)===host(`https://${canonical}`)&&(!seedFinal||host(seedFinal)===host(site)&&path(seedFinal)===path(site));
  } catch {return false;}
}
export function scoreRun({seedUsable, relevantFindings, unattempted, technicalSeo, relevantPages, failed, pageSpeed, startedAt}) {
  return [Number(seedUsable),Number(relevantFindings>0),Number(unattempted===0),Number(technicalSeo==='complete'),Math.min(relevantPages,20),-failed,Number(pageSpeed==='complete'),Date.parse(startedAt)];
}
export function compareRuns(a,b) {
  for(let i=0;i<a.score.length;i++)if(a.score[i]!==b.score[i])return b.score[i]-a.score[i];
  return a.run.localeCompare(b.run);
}
