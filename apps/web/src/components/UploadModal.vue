<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import {
  createGroup,
  fetchGroups,
  uploadToGroup,
  type GroupNode,
} from "@/api/library";

const emit = defineEmits<{ close: []; uploaded: [] }>();

const groups = ref<GroupNode[]>([]);
const selectedGroupId = ref<string | null>(null);
const files = ref<File[]>([]);
const busy = ref(false);
const message = ref("");
const error = ref("");
const duplicate = ref<{ fileName: string } | null>(null);
const newGroupName = ref("");
const showNewGroup = ref(false);

async function loadGroups(): Promise<void> {
  try {
    const tree = await fetchGroups();
    groups.value = tree.groups;
  } catch {
    groups.value = [];
  }
}

onMounted(() => void loadGroups());

function pickFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  files.value = Array.from(input.files ?? []);
  duplicate.value = null;
  error.value = "";
}

async function upload(overwrite = false): Promise<void> {
  if (files.value.length === 0) return;
  busy.value = true;
  error.value = "";
  duplicate.value = null;
  try {
    const result = await uploadToGroup(
      files.value,
      selectedGroupId.value,
      overwrite,
    );
    if (result.duplicate) {
      duplicate.value = result.duplicate;
      busy.value = false;
      return;
    }
    message.value = `Uploaded ${result.uploaded.length} files, indexing…`;
    emit("uploaded");
    setTimeout(() => emit("close"), 1200);
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
  }
}

async function addGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  try {
    await createGroup(name, selectedGroupId.value);
    newGroupName.value = "";
    showNewGroup.value = false;
    await loadGroups();
  } catch (err) {
    error.value = String(err);
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-md rounded-xl border bg-card p-5 shadow-lg">
      <h2 class="mb-4 text-base font-semibold">Upload</h2>

      <div class="mb-3 flex flex-col gap-1.5">
        <Label>Target group</Label>
        <select
          v-model="selectedGroupId"
          class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option :value="null">Ungrouped</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.name }}（{{ g.fileCount }}）
          </option>
        </select>
      </div>

      <label
        class="mb-3 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input p-6 text-sm text-muted-foreground transition-colors hover:border-ring hover:bg-accent/30"
      >
        <span v-if="files.length === 0"
          >Click to select files (multiple allowed)</span
        >
        <span v-else class="font-medium text-foreground">
          {{ files.length }} files
        </span>
        <input type="file" multiple class="hidden" @change="pickFiles" />
      </label>

      <div
        v-if="duplicate"
        class="mb-3 rounded border border-destructive/50 bg-destructive/10 p-3 text-sm"
      >
        <p class="font-medium">
          「{{ duplicate.fileName }}」already exists in this group
        </p>
        <p class="mt-1 text-muted-foreground">Overwrite?</p>
        <div class="mt-2 flex gap-2">
          <Button size="sm" variant="destructive" @click="upload(true)">
            Overwrite
          </Button>
          <Button size="sm" variant="outline" @click="duplicate = null">
            Cancel
          </Button>
        </div>
      </div>

      <div v-if="showNewGroup" class="mb-3 flex gap-2">
        <Input v-model="newGroupName" placeholder="New group name…" />
        <Button size="sm" variant="outline" @click="addGroup">Create</Button>
      </div>

      <p v-if="error" class="mb-3 text-sm text-destructive">{{ error }}</p>
      <p v-if="message" class="mb-3 text-sm text-muted-foreground">
        {{ message }}
      </p>

      <div class="flex items-center justify-between">
        <button
          class="text-xs text-muted-foreground hover:underline"
          @click="showNewGroup = !showNewGroup"
        >
          {{ showNewGroup ? "Collapse" : "+ New Group" }}
        </button>
        <div class="flex gap-2">
          <Button variant="ghost" size="sm" @click="emit('close')"
            >Close</Button
          >
          <Button
            size="sm"
            :disabled="busy || files.length === 0 || !!duplicate"
            @click="upload(false)"
          >
            {{ busy ? "Uploading…" : "Upload" }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
