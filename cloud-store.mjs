// Dedicated PostgreSQL connection: session locks require a direct (non-pooler) URL.
export function plannerDatabase(connection) {
  return {prepare(sql) {
    let index=0;
    const query=sql.replaceAll('rowid','sequence').replace(/\?/g,()=>`$${++index}`);
    return {
      get:async(...values)=>(await connection.query(query,values)).rows[0],
      all:async(...values)=>(await connection.query(query,values)).rows,
      run:async(...values)=>connection.query(query,values)
    };
  }};
}
export async function initializeCloud(connection) {
  await connection.query(`CREATE TABLE IF NOT EXISTS plans(sequence BIGSERIAL UNIQUE,id TEXT PRIMARY KEY,created TEXT,mode TEXT,status TEXT,plan TEXT,detail TEXT,entry_id TEXT,stop_id TEXT,target_id TEXT,entry_status TEXT,stop_status TEXT,target_status TEXT,filled DOUBLE PRECISION DEFAULT 0,result DOUBLE PRECISION,updated TEXT)`);
  // The previous request has ended: an interrupted submission must never be retried.
  await connection.query("UPDATE plans SET status='unknown',detail='Previous submission interrupted. Refresh to reconcile; never automatically resubmitted.' WHERE status='submitting'");
}
