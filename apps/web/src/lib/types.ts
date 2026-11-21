export type Role = 'OWNER' | 'MANAGER' | 'EDITOR' | 'READER';
export type SpaceType = 'COMPANY' | 'SHARED' | 'PERSONAL';

export interface Me {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'USER' | 'ADMIN';
    canCreateSpaces: boolean;
  };
  personalSpaceId: string | null;
  pendingInvitations: number;
  limits: { maxFileSizeBytes: number };
}

export interface FileItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  category: string;
  spaceId: string;
  folderId: string | null;
  uploader: { id: string; name: string } | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isFavorite: boolean;
  canDelete: boolean;
  spaceName?: string;
  spaceType?: SpaceType;
  folderName?: string | null;
  accessedAt?: string;
}

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  restricted: boolean;
  createdAt: string;
  updatedAt: string;
  canWrite: boolean;
  canDelete: boolean;
}

export interface Contents {
  space: { id: string; type: SpaceType; name: string; role: Role };
  folder: { id: string; name: string; parentId: string | null } | null;
  breadcrumbs: { id: string; name: string }[];
  canWrite: boolean;
  folders: FolderItem[];
  files: FileItem[];
}

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface SharedSpace {
  id: string;
  name: string;
  description: string;
  role: Role;
  owner: Person | null;
  memberCount: number;
  createdAt: string;
}

