<script setup lang="ts">
// shadcn-vue Tabs (reka-ui) in one file: the list is a row of file names, like an editor's tab strip.
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
defineProps<{ tabs: { id: string; label: string }[]; label: string }>();
</script>

<template>
  <TabsRoot :default-value="tabs[0].id" class="ec-tabs">
    <TabsList :aria-label="label" class="ec-tabs-list">
      <TabsTrigger v-for="t in tabs" :key="t.id" :value="t.id" class="ec-tab">{{ t.label }}</TabsTrigger>
    </TabsList>
    <TabsContent v-for="t in tabs" :key="t.id" :value="t.id" class="ec-tab-panel">
      <slot :name="t.id" />
    </TabsContent>
  </TabsRoot>
</template>
