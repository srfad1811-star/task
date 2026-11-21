import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Blueprint-synchronized schema limits (verbatim from firebase-blueprint.json)
export const CHANNEL_SCHEMA_LIMITS = {
  channelIdMaxLength: 64,
  channelIdPattern: /^[a-zA-Z0-9_\-\s]*$/,
  channelNameMinLength: 1,
  channelNameMaxLength: 120,
  categoryMinLength: 1,
  categoryMaxLength: 48,
  notesMaxLength: 500,
  docIdMaxLength: 128,
  docIdPattern: /^[a-zA-Z0-9_-]+$/,
} as const;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Startup connection validation
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export interface CloudChannelRecord {
  id: string;
  channelId: string | null;
  channelName: string;
  category: string;
  notes: string | null;
  visibility: 'public';
  createdByUid: string;
}

export function deriveCloudChannelKey(channelId: string | undefined, channelName: string): string {
  const idClean = (channelId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (idClean) {
    return `ch_id_${idClean}`.slice(0, CHANNEL_SCHEMA_LIMITS.docIdMaxLength);
  }
  const nameClean = channelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeName = nameClean || `ch_${Date.now()}`;
  return `ch_name_${safeName}`.slice(0, CHANNEL_SCHEMA_LIMITS.docIdMaxLength);
}

function sanitizeChannelPayload(
  input: {
    channelName: string;
    channelId?: string;
    category?: string;
    notes?: string;
  },
  uid: string
) {
  const channelName = input.channelName.trim().slice(0, CHANNEL_SCHEMA_LIMITS.channelNameMaxLength);
  if (channelName.length < CHANNEL_SCHEMA_LIMITS.channelNameMinLength) {
    throw new Error('Channel name is required.');
  }
  const category = (input.category || 'General').trim().slice(0, CHANNEL_SCHEMA_LIMITS.categoryMaxLength) || 'General';
  const rawChannelId = (input.channelId || '').trim().slice(0, CHANNEL_SCHEMA_LIMITS.channelIdMaxLength);
  const channelId = CHANNEL_SCHEMA_LIMITS.channelIdPattern.test(rawChannelId)
    ? rawChannelId
    : rawChannelId.replace(/[^a-zA-Z0-9_\-\s]/g, '');
  const notes = (input.notes || '').trim().slice(0, CHANNEL_SCHEMA_LIMITS.notesMaxLength);

  const payload: Record<string, unknown> = {
    channelName,
    category,
    visibility: 'public',
    createdByUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const updatePayload: Record<string, unknown> = {
    channelName,
    category,
    updatedAt: serverTimestamp(),
  };

  if (channelId) {
    payload.channelId = channelId;
    updatePayload.channelId = channelId;
  }
  if (notes) {
    payload.notes = notes;
    updatePayload.notes = notes;
  }

  return {
    channelKey: deriveCloudChannelKey(channelId || undefined, channelName),
    channelName,
    channelId: channelId || null,
    category,
    payload,
    updatePayload,
  };
}

export interface GoogleSignInResult {
  user: User | null;
  cancelled?: boolean;
  errorMessage?: string;
}

let pendingGoogleSignIn: Promise<GoogleSignInResult> | null = null;

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  if (auth.currentUser) {
    return { user: auth.currentUser };
  }
  if (pendingGoogleSignIn) {
    return pendingGoogleSignIn;
  }

  pendingGoogleSignIn = (async (): Promise<GoogleSignInResult> => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      return { user: result.user };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';

      if (code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user') {
        return {
          user: auth.currentUser,
          cancelled: true,
        };
      }

      if (code === 'auth/popup-blocked') {
        return {
          user: null,
          errorMessage: 'Browser blocked the Google sign-in popup. Please allow popups for this site and click Sign In again.',
        };
      }

      return {
        user: null,
        errorMessage: error instanceof Error ? error.message : 'Google sign-in failed. Please try again.',
      };
    } finally {
      pendingGoogleSignIn = null;
    }
  })();

  return pendingGoogleSignIn;
}

export async function signOutGoogle(): Promise<void> {
  await signOut(auth);
}

export function subscribePublicCloudChannels(
  onChannels: (channels: CloudChannelRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'channels';
  const q = query(collection(db, path), where('visibility', '==', 'public'));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: CloudChannelRecord[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          channelId: typeof data.channelId === 'string' && data.channelId ? data.channelId : null,
          channelName: typeof data.channelName === 'string' ? data.channelName : d.id,
          category: typeof data.category === 'string' ? data.category : 'General',
          notes: typeof data.notes === 'string' ? data.notes : null,
          visibility: 'public',
          createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : '',
        };
      });
      list.sort((a, b) => a.channelName.localeCompare(b.channelName));
      onChannels(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function saveCloudChannel(input: {
  channelName: string;
  channelId?: string;
  category?: string;
  notes?: string;
}): Promise<{ id: string; channelName: string; channelId: string | null }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in with Google first to save channels permanently to the cloud.');
  }

  const { channelKey, channelName, channelId, payload, updatePayload } = sanitizeChannelPayload(
    input,
    user.uid
  );
  const path = `channels/${channelKey}`;
  const ref = doc(db, 'channels', channelKey);
  try {
    const existingSnap = await getDoc(ref);
    if (existingSnap.exists()) {
      await updateDoc(ref, updatePayload);
    } else {
      await setDoc(ref, payload);
    }
    return { id: channelKey, channelName, channelId };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveCloudChannelsBulk(
  items: Array<{ channelName: string; channelId?: string; category?: string; notes?: string }>
): Promise<{ added: number }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in with Google first to save channels permanently to the cloud.');
  }

  const deduped = new Map<string, ReturnType<typeof sanitizeChannelPayload>>();
  for (const item of items) {
    if (!item.channelName || !item.channelName.trim()) continue;
    const prepared = sanitizeChannelPayload(item, user.uid);
    deduped.set(prepared.channelKey, prepared);
  }
  const validPrepared = Array.from(deduped.values());

  if (validPrepared.length === 0) {
    throw new Error('Provide at least one valid channel name.');
  }

  const CHUNK_SIZE = 400;
  try {
    const existingSnap = await getDocs(
      query(collection(db, 'channels'), where('visibility', '==', 'public'))
    );
    const existingIds = new Set(existingSnap.docs.map((d) => d.id));

    for (let i = 0; i < validPrepared.length; i += CHUNK_SIZE) {
      const chunk = validPrepared.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      for (const item of chunk) {
        const ref = doc(db, 'channels', item.channelKey);
        if (existingIds.has(item.channelKey)) {
          batch.update(ref, item.updatePayload);
        } else {
          batch.set(ref, item.payload);
        }
      }
      await batch.commit();
    }
    return { added: validPrepared.length };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'channels');
  }
}

export async function deleteCloudChannel(channelKey: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in with Google first to remove a permanent cloud channel.');
  }
  const path = `channels/${channelKey}`;
  try {
    await deleteDoc(doc(db, 'channels', channelKey));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
