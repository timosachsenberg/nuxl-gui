<script lang="ts">
  // A small word next to an accession or a peptide: "contaminant", "decoy", "co-isolated" (with what it means
  // as its tooltip).
  let { text, title }: { text: string; title?: string } = $props()
</script>

<span
  class="ml-1.5 rounded-[4px] border px-1 py-px align-[1px] font-sans text-[10.5px] leading-none font-normal text-muted-foreground"
  {title}>{text}</span>
