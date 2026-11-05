import { domainToASCII } from 'node:url';
/** Company policy identity only. Never rewrites the audited target URL or stored approvals. */
export function canonicalCompanyHost(value:unknown):string {
 if(typeof value!=='string'||!value||value.length>1024||/[\\/:@?#%\s\u0000-\u001f\u007f]/u.test(value))throw Error('invalid_company_host');
 const ascii=domainToASCII(value).toLowerCase();
 if(!ascii||ascii.endsWith('..'))throw Error('invalid_company_host');
 const host=ascii.replace(/\.$/u,'').replace(/^(?:www\.)+/u,'');
 if(!host||host.length>253||!host.split('.').every(label=>label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)))throw Error('invalid_company_host');
 return host;
}
export function canonicalCampaignKey(value:{company:string;campaign:string}):string {return JSON.stringify([canonicalCompanyHost(value.company),value.campaign]);}
