const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const target='ExposicoesSupervised1793404800000';
const constraint='exposicoes_startups_origem_recomendacao_check';
async function state(db){
 const tables={};
 for(const {tablename} of await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")){
  const name='"'+tablename.replaceAll('"','""')+'"';
  [tables[tablename]]=await db.query(`SELECT count(*)::int n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) digest FROM (SELECT md5(row_to_json(t)::text) h FROM public.${name} t) s`);
 }
 return{tables,columns:await db.query("SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"),
  indexes:await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname"),
  constraints:await db.query("SELECT c.relname,x.conname,x.contype,pg_get_constraintdef(x.oid) definition,x.convalidated FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,x.conname"),
  history:await db.query('SELECT id,timestamp::text timestamp,name FROM public.migrations ORDER BY id'),
  sequences:await db.query("SELECT sequencename,last_value::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")};
}
function assertMigrationOnly(before,after){
 assert.deepEqual(after.columns,before.columns);assert.deepEqual(after.indexes,before.indexes);
 const other=s=>s.constraints.filter(c=>!(c.relname==='exposicoes_startups'&&c.conname===constraint));
 assert.deepEqual(other(after),other(before));
 for(const name of Object.keys(before.tables))if(name!=='migrations')assert.deepEqual(after.tables[name],before.tables[name],name+' data changed');
 assert.deepEqual(Object.keys(after.tables),Object.keys(before.tables));
 assert.deepEqual(after.history.slice(0,-1),before.history);assert.equal(after.history.length,before.history.length+1);
 assert.equal(after.history.at(-1).name,target);assert.equal(after.history.at(-1).timestamp,'1793404800000');assert.equal(after.tables.migrations.n,before.tables.migrations.n+1);
 const sequences=s=>s.sequences.filter(v=>v.sequencename!=='migrations_id_seq');assert.deepEqual(sequences(after),sequences(before));
 const changed=after.constraints.find(c=>c.relname==='exposicoes_startups'&&c.conname===constraint);
 assert.equal(changed.convalidated,true);assert.deepEqual(changed.definition.match(/'([^']+)'/g),["'discovery'","'rules'","'supervised'"]);
}
module.exports={state,hash,target,constraint,assertMigrationOnly};
