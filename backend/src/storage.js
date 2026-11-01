import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
      async createUploadUrl(maxBytes) {
        const key = `pending/${newKey()}`;
        const { url, fields } = await createPresignedPost(client, {
          Bucket: bucket,
          Key: key,
          Expires: 300,
          Fields: { 'Content-Type': 'application/pdf' },
          Conditions: [
            ['content-length-range', 1, maxBytes + 64 * 1024],
            ['eq', '$Content-Type', 'application/pdf']
          ]
        });
        return { key, url, fields };
      },
      async validateUploadedFile(key, maxBytes) {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (result.ContentLength < 5 || result.ContentLength > maxBytes ||
            result.ContentType !== 'application/pdf') {
          const error = new Error('O PDF enviado e invalido ou excede o limite de tamanho.');
          error.status = 400;
          throw error;
        }
        const prefix = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: 'bytes=0-4'
        }));
        const signature = Buffer.from(await prefix.Body.transformToByteArray());
        if (signature.toString() !== '%PDF-') {
          const error = new Error('O arquivo selecionado nao e um PDF valido.');
          error.status = 400;
          throw error;
        }
      },
      async finalizeUpload(key) {
        const fileName = key.slice('pending/'.length);
        const finalKey = `slides/${fileName}`;
        try {
          await client.send(new CopyObjectCommand({
            Bucket: bucket,
            Key: finalKey,
            CopySource: `${bucket}/${key}`,
            ContentType: 'application/pdf',
            MetadataDirective: 'REPLACE'
          }));
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          return finalKey;
        } catch (error) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: finalKey }));
          } catch (cleanupError) {
            console.error('Nao foi possivel remover o PDF apos falha ao finalizar o upload:', cleanupError);
          }
          throw error;
        }
      },
      async createDownloadUrl(key) {
        return getSignedUrl(client, new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: 'application/pdf',
          ResponseContentDisposition: 'attachment; filename="slides.pdf"'
        }), { expiresIn: 60 });
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
