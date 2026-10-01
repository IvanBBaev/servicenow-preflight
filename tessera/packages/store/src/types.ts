// Vendored from github.com/IvanBBaev/syncrona @ 73cae76 (packages/types/index.d.ts).
// GPL-3.0 upstream; dual-licensed for this use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Minimal subset of the upstream @syncrona/types declarations: only the SN and
// Sync members the vendored modules actually reference, which is FileUtils and
// manifestBuilder alone — fieldMap, collaborationLock and support name no `SN.`
// or `Sync.` type at all. `Sync.Config` is thinned further still, to the three
// fields the two `Pick<Sync.Config, …>` uses name. Everything else (CLI arg
// shapes, plugin machinery, push/build result types) was intentionally left
// behind.
//
// The upstream file is a bare `index.d.ts` using `export namespace`; that shape
// is preserved here so the vendored module bodies keep their `SN.X` / `Sync.X`
// references byte-for-byte.
/* eslint-disable @typescript-eslint/no-namespace */

export namespace Sync {
  export interface Config {
    includes?: TablePropMap;
    excludes?: TablePropMap;
    tableOptions: ITableOptionsMap;
  }

  export interface ITableOptionsMap {
    [table: string]: ITableOptions;
  }

  export interface ITableOptions {
    displayField?: string;
    differentiatorField?: string | string[];
    query: string;
  }

  export interface FieldConfig {
    type: SN.FileType;
  }
  export interface FieldMap {
    [fieldName: string]: FieldConfig;
  }
  export interface TablePropMap {
    [table: string]: boolean | FieldMap;
  }
  export interface FileSyncParams {
    filePath: string;
    name: string;
    tableName: string;
    targetField: string;
    ext: string;
  }

  export interface FileContext extends FileSyncParams {
    sys_id: string;
    scope: string;
    fileContents?: string;
  }
}

export namespace SN {
  export interface AppManifest {
    tables: TableMap;
    scope: string;
  }

  export interface TableMap {
    [tableName: string]: TableConfig;
  }

  export interface TableConfig {
    records: TableConfigRecords;
  }

  export interface TableConfigRecords {
    [name: string]: MetaRecord;
  }

  export interface MetaRecord {
    files: File[];
    name: string;
    sys_id: string;
  }

  export interface File {
    name: string;
    type: FileType;
    content?: string;
  }

  export type FileType = "js" | "css" | "xml" | "html" | "scss" | "txt";

  export interface MissingFileTableMap {
    [tableName: string]: MissingFileRecord;
  }
  export interface MissingFileRecord {
    [sys_id: string]: File[];
  }
  export interface App {
    scope: string;
    displayName: string;
    sys_id: string;
  }
}
