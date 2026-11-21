import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** The two buckets: unscanned uploads, and released (CLEAN) files plus sanitized copies and signatures. */
export type Bucket = 'quarantine' | 'attachments';

export interface ObjectStore {
  put(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(bucket: Bucket, key: string): Promise<Buffer | null>;
  delete(bucket: Bucket, key: string): Promise<void>;
}

export interface S3Settings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: Record<Bucket, string>;
}

/**
 * MinIO / S3 store. Every object is written with SSE (AES-256) on top of the
 * bucket default; buckets have no anonymous access (infra/minio/init-buckets.sh).
 */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;

  constructor(private readonly settings: S3Settings) {
    this.s3 = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    });
  }

  async put(bucket: Bucket, key: string, body: Buffer, contentType: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.settings.buckets[bucket],
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(bucket: Bucket, key: string) {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.settings.buckets[bucket], Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }

  async delete(bucket: Bucket, key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.settings.buckets[bucket], Key: key }));
  }
}

/** In-memory store for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(bucket: Bucket, key: string, body: Buffer, contentType: string) {
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(body), contentType });
  }

  async get(bucket: Bucket, key: string) {
    const o = this.objects.get(`${bucket}/${key}`);
    return o ? Buffer.from(o.body) : null;
  }

  async delete(bucket: Bucket, key: string) {
    this.objects.delete(`${bucket}/${key}`);
  }
}
