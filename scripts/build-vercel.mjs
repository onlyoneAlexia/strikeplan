import {mkdirSync,cpSync} from 'node:fs';
mkdirSync('dist',{recursive:true});
cpSync('public','dist',{recursive:true});
