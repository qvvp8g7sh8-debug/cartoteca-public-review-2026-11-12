const {migrateSelectedAccounts}=require('../src/server/migrations/002-selected-accounts.cjs');
const args=process.argv.slice(2);
const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const emails=args.flatMap((x,i)=>x==='--email'?[args[i+1]]:[]);
try{
  if(!value('--source')||!value('--destination'))throw Error('Use --source, --destination, --backups and repeated --email.');
  const result=migrateSelectedAccounts({source:value('--source'),destination:value('--destination'),backupDirectory:value('--backups'),emails,dryRun:args.includes('--dry-run')});
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
