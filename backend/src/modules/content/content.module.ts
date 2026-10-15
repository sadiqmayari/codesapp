import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContentController } from './content.controller';
import { ContentOAuthController } from './content-oauth.controller';
import { ContentService } from './content.service';
import { GDriveService } from './gdrive.service';

/**
 * Content module — content planning + Google-Drive-backed media + approval
 * pipeline. AuthModule provides the JWT strategy/guard; Prisma / Encryption /
 * FeatureService come from the @Global CommonModule. Leaf module (nothing
 * imports it) so no DI cycle.
 */
@Module({
  imports: [AuthModule],
  controllers: [ContentController, ContentOAuthController],
  providers: [ContentService, GDriveService],
})
export class ContentModule {}
