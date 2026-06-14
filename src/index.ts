export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await fetch("https://api.example.com/large-dataset");
    return new Response(response.body, response);
  },
} satisfies ExportedHandler<Env>;
