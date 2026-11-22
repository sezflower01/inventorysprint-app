const FinalCTA = () => {
  return (
    <section className="py-24 bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[200px]" />
      <div className="container mx-auto px-4 relative z-10 text-center">
        <div className="space-y-3 text-muted-foreground text-base max-w-md mx-auto">
          <p>Organize and store your proven Amazon products</p>
          <p>Track supplier links and product history in one place</p>
          <p>Reorder faster with direct supplier access</p>
          <p>Know what to reorder before you run out</p>
          <p>Automate pricing with rule-based decisions, reviewed by Gemini</p>
        </div>
      </div>
    </section>
  );
};

export default FinalCTA;
