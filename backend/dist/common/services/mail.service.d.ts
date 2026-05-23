import { ConfigService } from '@nestjs/config';
export declare class MailService {
    private readonly config;
    private readonly logger;
    private readonly mailer;
    constructor(config: ConfigService);
    send(to: string, subject: string, html: string): Promise<void>;
    private sendViaResend;
}
