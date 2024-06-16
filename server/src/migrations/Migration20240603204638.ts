import { Migration } from '@mikro-orm/migrations';

export class Migration20240603204638 extends Migration {
  async up(): Promise<void> {
    this.addSql('PRAGMA foreign_keys = OFF;');
    this.addSql(
      "CREATE TABLE `_knex_temp_alter808` (`uuid` text NOT NULL, `created_at` datetime NULL, `updated_at` datetime NULL, `source_type` text check (`source_type` in ('plex', 'plex-guid', 'tmdb', 'imdb', 'tvdb')) NOT NULL, `external_source_id` text NULL, `external_key` text NOT NULL, `external_file_path` text NULL, `direct_file_path` text NULL, `program_uuid` text NOT NULL, CONSTRAINT `program_external_id_program_uuid_foreign` FOREIGN KEY (`program_uuid`) REFERENCES `program` (`uuid`) ON UPDATE CASCADE, PRIMARY KEY (`uuid`));",
    );
    this.addSql(
      'INSERT INTO "_knex_temp_alter808" SELECT * FROM "program_external_id";',
    );
    this.addSql('DROP TABLE "program_external_id";');
    this.addSql(
      'ALTER TABLE "_knex_temp_alter808" RENAME TO "program_external_id";',
    );
    this.addSql('PRAGMA foreign_keys = ON;');
    this.addSql(
      'create unique index if not exists `unique_program_multiple_external_id` on `program_external_id` (`program_uuid`, `source_type`) WHERE `external_source_id` IS NOT NULL;',
    );
    this.addSql(
      'create unique index if not exists `unique_program_single_external_id` on `program_external_id` (`program_uuid`, `source_type`) WHERE `external_source_id` IS NULL;',
    );
  }
}
