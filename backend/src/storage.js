import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';

const provider = (process.env.CLOUD_PROVIDER || 'aws').toLowerCase();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`A variavel de ambiente ${name} e obrigatoria para ${provider}.`);
  }
  return value;
}

function newKey() {
  return `${randomUUID()}.pdf`;
}

export function createStorage() {
  if (provider === 'aws') {
    const bucket = requiredEnv('AWS_S3_BUCKET');
    const client = new S3Client({ region: requiredEnv('AWS_REGION') });

    return {
      async uploadFile(buffer) {
        const key = newKey();
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: 'application/pdf'
        }));
        return key;
      },
      async downloadFile(key) {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await result.Body.transformToByteArray());
      },
      async deleteFile(key) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
    };
  }

  if (provider === 'gcp') {
    const bucket = new Storage().bucket(requiredEnv('GCS_BUCKET'));

    return {
      async uploadFile(buffer) {
        const key = newKey();
        await bucket.file(key).save(buffer, {
          resumable: false,
          metadata: { contentType: 'application/pdf' }
        });
        return key;
      },
      async downloadFile(key) {
        const [buffer] = await bucket.file(key).download();
        return buffer;
      },
      async deleteFile(key) {
        await bucket.file(key).delete({ ignoreNotFound: true });
      }
    };
  }

  if (provider === 'azure') {
    const container = BlobServiceClient
      .fromConnectionString(requiredEnv('AZURE_STORAGE_CONNECTION_STRING'))
      .getContainerClient(requiredEnv('AZURE_STORAGE_CONTAINER'));

    return {
      async uploadFile(buffer) {
        const key = newKey();
        await container.getBlockBlobClient(key).uploadData(buffer, {
          blobHTTPHeaders: { blobContentType: 'application/pdf' }
        });
        return key;
      },
      async downloadFile(key) {
        return container.getBlockBlobClient(key).downloadToBuffer();
      },
      async deleteFile(key) {
        await container.getBlockBlobClient(key).deleteIfExists();
      }
    };
  }

  if (provider === 'local') {
    const directory = path.resolve(process.env.LOCAL_STORAGE_DIR || './uploads');

    return {
      async uploadFile(buffer) {
        const key = newKey();
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, key), buffer, { flag: 'wx' });
        return key;
      },
      async downloadFile(key) {
        return readFile(path.join(directory, key));
      },
      async deleteFile(key) {
        await rm(path.join(directory, key), { force: true });
      }
    };
  }

  throw new Error(`CLOUD_PROVIDER invalido: "${provider}". Use aws, gcp, azure ou local.`);
}
