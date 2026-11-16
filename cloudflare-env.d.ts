declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    ADMIN_EMAILS?: string;
    NPU_INGEST_TOKEN?: string;
    NPU_MONITORING_RETIREMENTS?: string;
    BUCKET?: R2Bucket;
  }
}
