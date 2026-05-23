import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BillingModule } from '../billing/billing.module';
import { SuperAdminService } from './super-admin.service';
import { SuperAdminController } from './super-admin.controller';
import { SuperAdminBootstrap } from './super-admin.bootstrap';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: '2h' },
      }),
    }),
    // Phases 4+4.5: SuperAdminService.suspendClient fires the suspension
    // email via LimitNotifierService (lives in BillingModule). Forgetting
    // this import = silent boot crash ("Nest can't resolve dependencies
    // of SuperAdminService"). See ERRORS.md.
    BillingModule,
  ],
  providers: [SuperAdminService, SuperAdminBootstrap],
  controllers: [SuperAdminController],
})
export class SuperAdminModule {}
