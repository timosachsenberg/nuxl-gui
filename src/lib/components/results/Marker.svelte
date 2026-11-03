<script lang="ts">
  // A small word next to an accession or a peptide: "contaminant", "decoy", "co-isolated" (with what it means
  // as its tooltip). `strong`: a badge that stands out, the "XL" of a cross-link.
  import { cn } from '$lib/utils'

  let { text, title, strong = false, class: extra }: { text: string; title?: string; strong?: boolean; class?: string } = $props()
</script>

<span
  class={cn(
    'ml-1.5 rounded-[4px] px-1 py-px align-[1px] font-sans leading-none',
    strong ? 'bg-primary text-[10px] font-semibold tracking-wide text-primary-foreground' : 'border text-[10.5px] font-normal text-muted-foreground',
    extra,
  )}
  {title}>{text}</span>
