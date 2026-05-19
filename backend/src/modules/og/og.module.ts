import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OgController } from './og.controller';
import { OgService } from './og.service';

/**
 * Shell-Polish-C. Sibling of inbox/contacts/templates. CacheService is
 * provided globally by CommonModule. AuthModule supplies the jwt strategy
 * used by AuthGuard('jwt') (same pattern as SettingsModule).
 */
@Module({
  imports: [AuthModule],
  controllers: [OgController],
  providers: [OgService],
})
export class OgModule {}
