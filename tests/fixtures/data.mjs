import {fileURLToPath} from 'node:url';
import {statSync} from 'node:fs';
export const sampleFile=name=>{const path=fileURLToPath(new URL('./data/'+name,import.meta.url));if(!statSync(path).isFile())throw Error('synthetic_fixture_missing: '+name);return path;};
