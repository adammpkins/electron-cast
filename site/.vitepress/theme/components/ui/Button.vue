<script setup lang="ts">
// shadcn-vue Button: cva variants over a Primitive, restyled to the brand (square corners, ink fill, signal focus ring).
import { Primitive } from "reka-ui";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const button = cva(
  "ec-btn inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "ec-btn-ink",
        signal: "ec-btn-signal",
        outline: "ec-btn-outline",
        ghost: "ec-btn-ghost",
      },
      size: { default: "h-11 px-5 text-[0.95rem]", sm: "h-9 px-3 text-sm", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
type Variant = "default" | "signal" | "outline" | "ghost";
type Size = "default" | "sm" | "icon";
const props = withDefaults(defineProps<{ as?: string; asChild?: boolean; variant?: Variant; size?: Size; class?: string }>(), { as: "button" });
</script>

<template>
  <Primitive :as="props.as" :as-child="props.asChild" :class="cn(button({ variant: props.variant, size: props.size }), props.class)">
    <slot />
  </Primitive>
</template>
