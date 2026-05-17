import { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { JobQueueService } from '../../common/services/job-queue.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';
export declare class MetaWebhookController {
    private readonly config;
    private readonly jobQueue;
    private readonly prisma;
    private readonly encryption;
    private readonly logger;
    constructor(config: ConfigService, jobQueue: JobQueueService, prisma: PrismaService, encryption: EncryptionService);
    private resolveSecrets;
    private handleVerify;
    private handleReceive;
    verify(mode: string, token: string, challenge: string, res: Response): Promise<void>;
    receive(req: RawBodyRequest<Request>, signature: string | undefined, res: Response): Promise<void>;
    verifyByKey(key: string, mode: string, token: string, challenge: string, res: Response): Promise<void>;
    receiveByKey(key: string, req: RawBodyRequest<Request>, signature: string | undefined, res: Response): Promise<void>;
    verifySignature(signatureHeader: string, rawBody: Buffer, appSecret: string): boolean;
}
