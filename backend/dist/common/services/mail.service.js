"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var MailService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const nodemailer = require("nodemailer");
const https = require("https");
let MailService = MailService_1 = class MailService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(MailService_1.name);
        this.mailer = nodemailer.createTransport({
            host: config.get('SMTP_HOST'),
            port: Number(config.get('SMTP_PORT') ?? 587),
            secure: false,
            auth: {
                user: config.get('SMTP_USER'),
                pass: config.get('SMTP_PASS'),
            },
        });
    }
    async send(to, subject, html) {
        const from = this.config.get('SMTP_FROM') ?? 'no-reply@codentra.pk';
        const resendKey = this.config.get('RESEND_API_KEY');
        try {
            if (resendKey) {
                await this.sendViaResend(resendKey, from, to, subject, html);
            }
            else {
                await this.mailer.sendMail({ from, to, subject, html });
            }
        }
        catch (e) {
            this.logger.error(`Email to ${to} ("${subject}") failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    sendViaResend(apiKey, from, to, subject, html) {
        const payload = JSON.stringify({ from, to: [to], subject, html });
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.resend.com',
                path: '/emails',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(payload),
                },
            }, (res) => {
                let data = '';
                res.on('data', (d) => (data += d));
                res.on('end', () => {
                    const code = res.statusCode ?? 0;
                    if (code >= 200 && code < 300)
                        resolve();
                    else
                        reject(new Error(`Resend HTTP ${code}: ${data}`));
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error('Resend request timeout')));
            req.write(payload);
            req.end();
        });
    }
};
exports.MailService = MailService;
exports.MailService = MailService = MailService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], MailService);
//# sourceMappingURL=mail.service.js.map