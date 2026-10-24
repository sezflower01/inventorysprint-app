
import { useLocation, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      {/* The SPA rewrite serves index.html for every path, so an unknown URL
          returns HTTP 200 with this page inside it -- a soft 404. Google read
          one of those (/download, which only ever existed as a downloadUrl in
          the homepage JSON-LD) as a real page and told people to sign up
          there. noindex is what stops an unknown path being indexed; the
          status code cannot be fixed from inside a static SPA. */}
      <Helmet>
        <meta name="robots" content="noindex, follow" />
        <meta name="googlebot" content="noindex, follow" />
        <title>Page not found | InventorySprint</title>
      </Helmet>
      <div className="text-center bg-white p-8 rounded-lg shadow-md max-w-md">
        <h1 className="text-5xl font-bold mb-4 text-gray-800">404</h1>
        <p className="text-xl text-gray-600 mb-6">Oops! Page not found</p>
        <p className="text-gray-500 mb-6">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link to="/">
          <Button className="bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-700 hover:to-cyan-600">
            <Home className="mr-2" size={18} />
            Return to Home
          </Button>
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
