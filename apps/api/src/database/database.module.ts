import { Module } from '@nestjs/common';
import { createPool } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

@Module({
  providers: [
    {
      provide: MYSQL_POOL,
      useFactory: () =>
        createPool({
          host: process.env.MYSQL_HOST ?? '127.0.0.1',
          port: Number(process.env.MYSQL_PORT ?? 3306),
          user: process.env.MYSQL_USER,
          password: process.env.MYSQL_PASSWORD,
          database: process.env.MYSQL_DATABASE,
          connectionLimit: 10,
          waitForConnections: true,
          queueLimit: 0,
        }),
    },
  ],
  exports: [MYSQL_POOL],
})
export class DatabaseModule {}
