import {Stream, Chunk, Layer, Effect,Context} from "effect"
import {S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import {fromIni} from "@aws-sdk/credential-providers";
import {PutObjectCommand} from "@aws-sdk/client-s3";
import {
  fileListResult,
  FileService,
  FileServiceError,
  fileWriteResult,
  pathFromDate,
  toError
} from "../../file-interface.ts";

export const AWS_PROFILE_NAME: string = process.env["AWS_PROFILE_NAME"] || "default";

export const s3FileService = (bucket: string) => Effect.gen(function*() {
  const s3Client = new S3Client({
    credentials: fromIni({ profile: AWS_PROFILE_NAME })
  });

  const listSince = (d: Date) => {
    const paginator = paginateListObjectsV2(
      {client: s3Client, pageSize: 1000},
      {Bucket: bucket, Prefix: pathFromDate(d)}
    );

    const r = Stream.fromAsyncIterable(paginator, (cause) => new Error(String(cause)))
      .pipe(
        Stream.map(page => (page.Contents ?? []).flatMap(o => o.Key ? [o.Key] : [])),
        Stream.flattenIterable,
        Stream.runCollect,
        Effect.map(fileListResult),
        Effect.mapError(toError(`${bucket}/${pathFromDate(d)}`))
      )

    return r
  }

  const writeFile = (toPath: string, content: any) => {
    try {
      const r = s3Client.send(new PutObjectCommand({
        Body: JSON.stringify(content),
        Bucket: bucket,
        Key: toPath
      }))
    }
    catch (err) {
      console.error(err)
      return Effect.fail(new FileServiceError({path: toPath, message: "Failure to write file to S3"}))
    }

    return Effect.succeed(fileWriteResult(true))
  }

  return {listSince, writeFile}
})

export const S3FileService = {
  layer: (bucket: string) => Layer.effect(FileService, s3FileService(bucket))
}
