import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../backend/.env') });

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`Super admin already exists: ${email}`);
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      company_id: null,
      name: 'Super Admin',
      email,
      password_hash: hash,
      role: 'super_admin',
      status: 'active',
    },
  });

  console.log(`Super admin created: ${email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
