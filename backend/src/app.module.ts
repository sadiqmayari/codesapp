import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { UsageMeteringModule } from './modules/usage-metering/usage-metering.module';
import { ShopifyModule } from './modules/integrations/shopify/shopify.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    SuperAdminModule,
    UsageMeteringModule,
    ShopifyModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
