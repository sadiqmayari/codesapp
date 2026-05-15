import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { UsageMeteringModule } from './modules/usage-metering/usage-metering.module';
import { ShopifyModule } from './modules/integrations/shopify/shopify.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { BroadcastsModule } from './modules/broadcasts/broadcasts.module';
import { BotsModule } from './modules/bots/bots.module';
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
    BotsModule,
    InboxModule,
    ContactsModule,
    TemplatesModule,
    BroadcastsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
