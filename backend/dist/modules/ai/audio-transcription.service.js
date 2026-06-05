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
var AudioTranscriptionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioTranscriptionService = exports.WHISPER_MICROS_PER_SEC = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = require("openai");
const fs = require("fs");
exports.WHISPER_MICROS_PER_SEC = 100;
let AudioTranscriptionService = AudioTranscriptionService_1 = class AudioTranscriptionService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(AudioTranscriptionService_1.name);
        this.client = null;
    }
    isConfigured() {
        return !!this.config.get('OPENAI_API_KEY');
    }
    getClient() {
        if (this.client)
            return this.client;
        const apiKey = this.config.get('OPENAI_API_KEY');
        if (!apiKey)
            return null;
        this.client = new openai_1.default({ apiKey });
        return this.client;
    }
    async transcribe(diskPath) {
        const client = this.getClient();
        if (!client)
            return null;
        try {
            if (!fs.existsSync(diskPath))
                return null;
            const res = await client.audio.transcriptions.create({
                model: 'whisper-1',
                file: fs.createReadStream(diskPath),
                response_format: 'verbose_json',
            });
            const text = res.text?.trim() ?? '';
            const durationSec = Number(res.duration ?? 0);
            if (!text)
                return null;
            return {
                text,
                durationSec: Number.isFinite(durationSec) ? durationSec : 0,
            };
        }
        catch (e) {
            this.logger.warn(`Whisper transcription failed for ${diskPath}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
};
exports.AudioTranscriptionService = AudioTranscriptionService;
exports.AudioTranscriptionService = AudioTranscriptionService = AudioTranscriptionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], AudioTranscriptionService);
//# sourceMappingURL=audio-transcription.service.js.map